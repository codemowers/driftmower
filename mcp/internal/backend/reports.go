package backend

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"sync"

	"golang.org/x/sync/singleflight"
)

const (
	reportsPath    = "reports"
	inClusterCtx   = "in-cluster"
	maxReportPages = 5
	// A ready report never changes, so its rows are cached for the process
	// lifetime. A search reads every cluster's latest report, so the bound
	// must comfortably exceed the number of clusters.
	maxCachedReports = 16
)

// allNamespaces is how the backend stores a full-cluster scope, as canonical
// JSON text a query can match.
var allNamespaces = `{"mode":"all"}`

// ReportSnapshot is a ready, full-cluster report.
type ReportSnapshot struct {
	ReportID       string
	ClusterContext string
	CreatedAt      string
}

type reportRow struct {
	ID             string  `json:"id"`
	ClusterContext *string `json:"clusterContext"`
	CreatedAt      string  `json:"createdAt"`
	NamespaceScope *struct {
		Mode string `json:"mode"`
	} `json:"namespaceScope"`
}

// isFullCluster rechecks the resolved scope, so a backend that stored it in
// another spelling cannot slip a partial report through: mixing partial
// reports in would make a workload look absent when it was out of scope.
func (r reportRow) isFullCluster() bool {
	return r.ClusterContext != nil && *r.ClusterContext != "" && r.NamespaceScope != nil && r.NamespaceScope.Mode == "all"
}

func (r reportRow) snapshot() ReportSnapshot {
	return ReportSnapshot{ReportID: r.ID, ClusterContext: *r.ClusterContext, CreatedAt: r.CreatedAt}
}

// reportQuery selects ready full-cluster reports. Selecting columns keeps the
// read cheap: without $select the backend assembles every row's analysis.
func reportQuery() Query {
	return Query{}.Set("sourceType", "cluster").Set("status", "ready").Set("namespaceScope", allNamespaces).
		Select("id", "clusterContext", "createdAt", "namespaceScope")
}

// LatestReports returns the newest ready full-cluster report per cluster, or
// for one cluster when given.
func (c *Client) LatestReports(ctx context.Context, cluster string) ([]ReportSnapshot, error) {
	// Newest first; the id breaks ties so the pick is stable across calls.
	q := reportQuery().Sort("createdAt", -1).Sort("id", -1)
	var rows []reportRow
	if cluster != "" {
		p, err := findPage[reportRow](ctx, c, reportsPath, q.Set("clusterContext", cluster).Set("$limit", "1"))
		if err != nil {
			return nil, err
		}
		rows = p.Data
	} else {
		var err error
		if rows, err = findAll[reportRow](ctx, c, reportsPath, q, maxReportPages, true); err != nil {
			return nil, err
		}
		rows = slices.DeleteFunc(rows, func(r reportRow) bool { return !r.isFullCluster() })
		// Cluster ascending, newest first, id descending, byte-wise as the
		// backend orders them.
		slices.SortStableFunc(rows, func(a, b reportRow) int {
			if c := strings.Compare(*a.ClusterContext, *b.ClusterContext); c != 0 {
				return c
			}
			if c := strings.Compare(b.CreatedAt, a.CreatedAt); c != 0 {
				return c
			}

			return strings.Compare(b.ID, a.ID)
		})
	}

	seen := map[string]bool{}
	out := []ReportSnapshot{}
	for _, r := range rows {
		if r.isFullCluster() && !seen[*r.ClusterContext] {
			seen[*r.ClusterContext] = true
			out = append(out, r.snapshot())
		}
	}

	return out, nil
}

// LatestInClusterReport is the newest report of the cluster this server runs
// in, or nil.
func (c *Client) LatestInClusterReport(ctx context.Context) (*ReportSnapshot, error) {
	reports, err := c.LatestReports(ctx, inClusterCtx)
	if err != nil || len(reports) == 0 {
		return nil, err
	}

	return &reports[0], nil
}

// InClusterReport returns a still-eligible in-cluster report by id, or nil.
func (c *Client) InClusterReport(ctx context.Context, id string) (*ReportSnapshot, error) {
	p, err := findPage[reportRow](ctx, c, reportsPath, reportQuery().Set("id", id).Set("clusterContext", inClusterCtx).Set("$limit", "1"))
	if err != nil || len(p.Data) == 0 || !p.Data[0].isFullCluster() {
		return nil, err
	}
	s := p.Data[0].snapshot()

	return &s, nil
}

// ImageUsage is one container image in a report.
type ImageUsage struct {
	ReportID          string  `json:"reportId"`
	WorkloadGroupKey  string  `json:"workloadGroupKey"`
	WorkloadKind      *string `json:"workloadKind"`
	WorkloadNamespace *string `json:"workloadNamespace"`
	WorkloadName      *string `json:"workloadName"`
	ReleaseGroupKey   *string `json:"releaseGroupKey"`
	ContainerName     *string `json:"containerName"`
	Registry          string  `json:"registry"`
	Repository        string  `json:"repository"`
	DeployedTag       *string `json:"deployedTag"`
	LatestTag         *string `json:"latestTag"`
	Status            string  `json:"status"`
	VersionStatus     *string `json:"versionStatus"`
}

// ReportRows are a report's image usages and its Helm release info, as raw
// JSON text keyed by release group key.
type ReportRows struct {
	ImageUsages []ImageUsage
	ReleaseInfo map[string]*string
}

// ReleaseInfoFor is the release info text of a row's release, or nil.
func (r *ReportRows) ReleaseInfoFor(releaseGroupKey *string) *string {
	if releaseGroupKey == nil {
		return nil
	}

	return r.ReleaseInfo[*releaseGroupKey]
}

// RowLoader caches report rows, least recently used first out. Concurrent
// loads of one report share one fetch.
type RowLoader struct {
	Client *Client

	mu     sync.Mutex
	order  []string
	rows   map[string]*ReportRows
	flight singleflight.Group
}

// The columns read: payload is most of every row by weight and nothing here
// reads it. The backend allows $select only on its query properties, so this
// also states which columns it must expose.
var imageUsageColumns = []string{"id", "reportId", "workloadGroupKey", "workloadKind", "workloadNamespace", "workloadName",
	"releaseGroupKey", "containerName", "registry", "repository", "deployedTag", "latestTag", "status", "versionStatus"}

func (l *RowLoader) Load(ctx context.Context, reportID string) (*ReportRows, error) {
	l.mu.Lock()
	if r, ok := l.rows[reportID]; ok {
		l.touch(reportID)
		l.mu.Unlock()

		return r, nil
	}
	l.mu.Unlock()

	v, err, _ := l.flight.Do(reportID, func() (any, error) {
		return l.fetch(context.WithoutCancel(ctx), reportID)
	})
	if err != nil {
		return nil, err
	}
	rows := v.(*ReportRows)
	l.mu.Lock()
	if l.rows == nil {
		l.rows = map[string]*ReportRows{}
	}
	l.rows[reportID] = rows
	l.touch(reportID)
	for len(l.order) > maxCachedReports {
		delete(l.rows, l.order[0])
		l.order = l.order[1:]
	}
	l.mu.Unlock()

	return rows, nil
}

func (l *RowLoader) touch(id string) {
	l.order = slices.DeleteFunc(l.order, func(o string) bool { return o == id })
	l.order = append(l.order, id)
}

func (l *RowLoader) fetch(ctx context.Context, reportID string) (*ReportRows, error) {
	// Both reads page, so each sorts on a key unique within a report: a page
	// boundary must fall in the same place on every request.
	var usages []ImageUsage
	var scores []releaseScore
	errs := make(chan error, 2)
	go func() {
		var err error
		usages, err = findAll[ImageUsage](ctx, l.Client, "image-usages",
			Query{}.Set("reportId", reportID).Select(imageUsageColumns...).Sort("id", 1), 0, false)
		errs <- err
	}()
	go func() {
		var err error
		scores, err = findAll[releaseScore](ctx, l.Client, "release-scores", Query{}.Set("reportId", reportID).Sort("groupKey", 1), 0, false)
		errs <- err
	}()
	for range 2 {
		if err := <-errs; err != nil {
			return nil, err
		}
	}

	rows := &ReportRows{ImageUsages: usages, ReleaseInfo: map[string]*string{}}
	for _, s := range scores {
		rows.ReleaseInfo[s.GroupKey] = releaseInfoText(s.ReleaseInfo)
	}

	return rows, nil
}

type releaseScore struct {
	GroupKey    string          `json:"groupKey"`
	ReleaseInfo json.RawMessage `json:"releaseInfo"`
}

// releaseInfoText tolerates release info stored as JSON text or as an
// object.
func releaseInfoText(raw json.RawMessage) *string {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return &text
	}
	s := string(raw)

	return &s
}

// ReleaseInfo is a Helm release's persisted analysis.
type ReleaseInfo struct {
	Name            *string `json:"name"`
	Namespace       *string `json:"namespace"`
	ChartName       *string `json:"chartName"`
	ChartVersion    *string `json:"chartVersion"`
	ChartAppVersion *string `json:"chartAppVersion"`
	LatestChartTag  *string `json:"latestChartTag"`
}

// ParseReleaseInfo returns nil for missing or malformed info.
func ParseReleaseInfo(text *string) *ReleaseInfo {
	if text == nil {
		return nil
	}
	var info ReleaseInfo
	if json.Unmarshal([]byte(*text), &info) != nil {
		return nil
	}

	return &info
}
