package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"

	"github.com/codemowers/driftmower/mcp/internal/tenancy"
)

// inScope confines rows to the caller's namespaces. Rows without a workload
// namespace are never in a scope: data whose namespace is unknown must not
// leak across tenants.
func inScope(u *ImageUsage, scope tenancy.Scope) bool {
	return !scope.Restricted || (u.WorkloadNamespace != nil && slices.Contains(scope.Namespaces, *u.WorkloadNamespace))
}

// jsonKey encodes values as a JSON array without HTML escaping, as an
// identity key.
func jsonKey(values ...any) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(values)

	return strings.TrimSuffix(b.String(), "\n")
}

func deref(s *string) string {
	if s == nil {
		return ""
	}

	return *s
}

// compareNullable sorts nulls first, as an ascending SQL order does.
func compareNullable(a, b *string) int {
	switch {
	case a == nil && b == nil:
		return 0
	case a == nil:
		return -1
	case b == nil:
		return 1
	default:
		return strings.Compare(*a, *b)
	}
}

func compareFold(a, b string) int {
	if c := strings.Compare(strings.ToLower(a), strings.ToLower(b)); c != 0 {
		return c
	}

	return strings.Compare(a, b)
}

// rankText ranks a match: 0 exact, 1 prefix, 2 substring. This is a
// deliberately simple heuristic, not an optimal search strategy.
func rankText(value *string, query string) (int, bool) {
	if value == nil {
		return 0, false
	}
	v := strings.ToLower(*value)
	switch {
	case v == "" || !strings.Contains(v, query):
		return 0, false
	case v == query:
		return 0, true
	case strings.HasPrefix(v, query):
		return 1, true
	default:
		return 2, true
	}
}

type ImageAnalysis struct {
	Registry       string  `json:"registry"`
	Repository     string  `json:"repository"`
	ObservedTag    *string `json:"observedTag"`
	LatestKnownTag *string `json:"latestKnownTag"`
	Status         *string `json:"status"`
	VersionStatus  *string `json:"versionStatus"`
}

type HelmAnalysis struct {
	ReleaseName             *string `json:"releaseName"`
	ReleaseNamespace        *string `json:"releaseNamespace"`
	ChartName               *string `json:"chartName"`
	ObservedChartVersion    *string `json:"observedChartVersion"`
	LatestKnownChartVersion *string `json:"latestKnownChartVersion"`
	AppVersion              *string `json:"appVersion"`
}

type WorkloadAnalysis struct {
	Status *string         `json:"status"`
	Helm   *HelmAnalysis   `json:"helm"`
	Images []ImageAnalysis `json:"images"`
}

type Snapshot struct {
	ReportID  string `json:"reportId"`
	CreatedAt string `json:"createdAt"`
}

type WorkloadMatch struct {
	WorkloadID string           `json:"workloadId"`
	Name       *string          `json:"name"`
	Kind       *string          `json:"kind"`
	Cluster    *string          `json:"cluster"`
	Namespace  *string          `json:"namespace"`
	Analysis   WorkloadAnalysis `json:"analysis"`
	Snapshot   Snapshot         `json:"snapshot"`
}

// SearchResult always carries the scope, so an empty result is never
// ambiguous between "no such workload" and "not yours to see".
type SearchResult struct {
	Query   string          `json:"query"`
	Matches []WorkloadMatch `json:"matches"`
	Scope   tenancy.Notice  `json:"scope"`
}

// Searcher searches workload names across every cluster's latest report.
type Searcher struct {
	Client       *Client
	Rows         *RowLoader
	DefaultLimit int
	MaximumLimit int
}

type candidate struct {
	report  ReportSnapshot
	usage   ImageUsage
	release *ReleaseInfo
	rank    int
}

func (s *Searcher) limit(requested int) (int, error) {
	if requested == 0 {
		requested = s.DefaultLimit
	}
	if requested < 1 {
		return 0, errors.New("limit must be a positive integer")
	}

	return min(requested, s.MaximumLimit), nil
}

// Search matches the query against workload name, namespace, kind, image
// repository and Helm release fields, ranked by field and match quality.
// Matching happens here so user input never reaches the backend as a filter.
func (s *Searcher) Search(ctx context.Context, query string, limit int, scope tenancy.Scope) (*SearchResult, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, errors.New("query must be a non-empty string")
	}
	limit, err := s.limit(limit)
	if err != nil {
		return nil, err
	}
	reports, err := s.Client.LatestReports(ctx, "")
	if err != nil {
		return nil, err
	}
	needle := strings.ToLower(query)

	var matches []candidate
	rowsByReport := map[string]*ReportRows{}
	for _, report := range reports {
		rows, err := s.Rows.Load(ctx, report.ReportID)
		if err != nil {
			return nil, err
		}
		rowsByReport[report.ReportID] = rows
		// One candidate per workload group, represented by the first row in
		// byte order, which decides which repository it can be found by.
		usages := slices.DeleteFunc(slices.Clone(rows.ImageUsages), func(u ImageUsage) bool { return !inScope(&u, scope) })
		slices.SortStableFunc(usages, func(a, b ImageUsage) int {
			if c := strings.Compare(a.WorkloadGroupKey, b.WorkloadGroupKey); c != 0 {
				return c
			}
			if c := compareNullable(a.WorkloadName, b.WorkloadName); c != 0 {
				return c
			}

			return strings.Compare(a.Repository, b.Repository)
		})
		seen := map[string]bool{}
		for _, u := range usages {
			if seen[u.WorkloadGroupKey] {
				continue
			}
			seen[u.WorkloadGroupKey] = true
			c := candidate{report: report, usage: u, release: ParseReleaseInfo(rows.ReleaseInfoFor(u.ReleaseGroupKey))}
			if rank, ok := c.rankAgainst(needle); ok {
				c.rank = rank
				matches = append(matches, c)
			}
		}
	}

	slices.SortStableFunc(matches, func(a, b candidate) int {
		if a.rank != b.rank {
			return a.rank - b.rank
		}
		if c := compareFold(deref(a.usage.WorkloadName), deref(b.usage.WorkloadName)); c != 0 {
			return c
		}
		if c := compareFold(a.report.ClusterContext, b.report.ClusterContext); c != 0 {
			return c
		}
		if c := compareFold(deref(a.usage.WorkloadNamespace), deref(b.usage.WorkloadNamespace)); c != 0 {
			return c
		}

		return compareFold(a.usage.WorkloadGroupKey, b.usage.WorkloadGroupKey)
	})
	if len(matches) > limit {
		matches = matches[:limit]
	}

	result := &SearchResult{Query: query, Matches: []WorkloadMatch{}, Scope: tenancy.Describe(scope, len(matches))}
	for _, m := range matches {
		result.Matches = append(result.Matches, m.toMatch(rowsByReport[m.report.ReportID], scope))
	}

	return result, nil
}

type rankField struct {
	value  *string
	offset int
}

// rankAgainst ranks by the best field: name, then namespace, kind,
// repository, Helm release identity and chart versions.
func (c candidate) rankAgainst(needle string) (int, bool) {
	fields := []rankField{{c.usage.WorkloadName, 0}, {c.usage.WorkloadNamespace, 3}, {c.usage.WorkloadKind, 6}, {&c.usage.Repository, 9}}
	if r := c.release; r != nil {
		fields = append(fields, rankField{r.Name, 12}, rankField{r.Namespace, 12}, rankField{r.ChartName, 12},
			rankField{r.ChartVersion, 15}, rankField{r.LatestChartTag, 15})
	}
	best, found := 0, false
	for _, f := range fields {
		if rank, ok := rankText(f.value, needle); ok && (!found || rank+f.offset < best) {
			best, found = rank+f.offset, true
		}
	}

	return best, found
}

var currentStatuses = map[string]bool{"up_to_date": true, "current": true}

// toMatch builds a match from every in-scope image row of the workload group.
func (c candidate) toMatch(rows *ReportRows, scope tenancy.Scope) WorkloadMatch {
	var details []ImageUsage
	for _, u := range rows.ImageUsages {
		if u.WorkloadGroupKey == c.usage.WorkloadGroupKey && inScope(&u, scope) {
			details = append(details, u)
		}
	}
	slices.SortStableFunc(details, func(a, b ImageUsage) int {
		if c := strings.Compare(a.Repository, b.Repository); c != 0 {
			return c
		}

		return compareNullable(a.ContainerName, b.ContainerName)
	})

	cluster := c.report.ClusterContext
	match := WorkloadMatch{
		WorkloadID: c.usage.WorkloadGroupKey, Name: c.usage.WorkloadName, Kind: c.usage.WorkloadKind, Cluster: &cluster,
		Namespace: c.usage.WorkloadNamespace, Snapshot: Snapshot{ReportID: c.report.ReportID, CreatedAt: c.report.CreatedAt},
		Analysis: WorkloadAnalysis{Images: []ImageAnalysis{}},
	}

	// The first version status that is not current, else the first one, else
	// the first image status.
	var firstVersion *string
	for _, u := range details {
		if u.VersionStatus == nil {
			continue
		}
		if firstVersion == nil {
			firstVersion = u.VersionStatus
		}
		if !currentStatuses[*u.VersionStatus] {
			match.Analysis.Status = u.VersionStatus

			break
		}
	}
	if match.Analysis.Status == nil {
		match.Analysis.Status = firstVersion
	}
	if match.Analysis.Status == nil {
		for _, u := range details {
			if u.Status != "" {
				status := u.Status
				match.Analysis.Status = &status

				break
			}
		}
	}

	seen := map[string]bool{}
	for _, u := range details {
		status := u.Status
		image := ImageAnalysis{Registry: u.Registry, Repository: u.Repository, ObservedTag: u.DeployedTag, LatestKnownTag: u.LatestTag,
			Status: &status, VersionStatus: u.VersionStatus}
		key := jsonKey(image)
		if !seen[key] {
			seen[key] = true
			match.Analysis.Images = append(match.Analysis.Images, image)
		}
		if match.Analysis.Helm == nil && u.ReleaseGroupKey != nil {
			if info := ParseReleaseInfo(rows.ReleaseInfoFor(u.ReleaseGroupKey)); info != nil {
				match.Analysis.Helm = &HelmAnalysis{ReleaseName: info.Name, ReleaseNamespace: info.Namespace, ChartName: info.ChartName,
					ObservedChartVersion: info.ChartVersion, LatestKnownChartVersion: info.LatestChartTag, AppVersion: info.ChartAppVersion}
			}
		}
	}
	slices.SortStableFunc(match.Analysis.Images, func(a, b ImageAnalysis) int {
		for _, c := range []int{
			compareFold(a.Registry, b.Registry), compareFold(a.Repository, b.Repository),
			compareFold(deref(a.ObservedTag), deref(b.ObservedTag)), compareFold(deref(a.LatestKnownTag), deref(b.LatestKnownTag)),
			compareFold(deref(a.Status), deref(b.Status)), compareFold(deref(a.VersionStatus), deref(b.VersionStatus)),
		} {
			if c != 0 {
				return c
			}
		}

		return 0
	})

	return match
}
