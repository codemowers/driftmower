package backend

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"strings"

	"github.com/codemowers/driftmower-mcp/internal/tenancy"
)

// ActionableStatuses are the version statuses an update plan acts on, riskiest
// first; the index is the risk rank.
var ActionableStatuses = []string{"major_behind", "minor_behind", "patch_behind", "behind"}

func riskRank(status string) int { return slices.Index(ActionableStatuses, status) }

const (
	tagUpdate   = "image_tag_update"
	chartUpdate = "helm_chart_update"
	review      = "manual_review"
	maxEvidence = 10
)

var planWarnings = []string{
	"This plan is based on a Driftmower analysis snapshot, not live cluster state.",
	"Proposed updates are advisory and do not confirm compatibility, maintenance approval, or deployment safety.",
}

type Filters struct {
	Namespace       *string  `json:"namespace"`
	VersionStatuses []string `json:"versionStatuses"`
}

// SortKey is an action's position in plan order, which a cursor resumes
// after.
type SortKey struct {
	RiskRank   int    `json:"riskRank"`
	ActionType string `json:"actionType"`
	Namespace  string `json:"namespace"`
	GroupKey   string `json:"groupKey"`
}

// compare orders riskiest first and is otherwise fully deterministic and
// byte-wise: the cursor is a position in exactly this order.
func (k SortKey) compare(o SortKey) int {
	if k.RiskRank != o.RiskRank {
		return k.RiskRank - o.RiskRank
	}
	for _, c := range []int{strings.Compare(k.ActionType, o.ActionType), strings.Compare(k.Namespace, o.Namespace), strings.Compare(k.GroupKey, o.GroupKey)} {
		if c != 0 {
			return c
		}
	}

	return 0
}

type cursor struct {
	Version         int      `json:"version"`
	ReportID        string   `json:"reportId"`
	Namespace       *string  `json:"namespace"`
	VersionStatuses []string `json:"versionStatuses"`
	LastAction      SortKey  `json:"lastAction"`
}

var base64URL = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

var (
	errMalformedCursor = errors.New("cursor is malformed")
	errCursorFilters   = errors.New("cursor does not match the requested filters")
)

func encodeCursor(reportID string, f Filters, last SortKey) string {
	b, _ := json.Marshal(cursor{Version: 2, ReportID: reportID, Namespace: f.Namespace, VersionStatuses: f.VersionStatuses, LastAction: last})

	return base64.RawURLEncoding.EncodeToString(b)
}

// decodeCursor is strict: unknown fields, out-of-range values and statuses
// out of canonical order are malformed. A cursor never carries the caller's
// scope, which it could otherwise widen.
func decodeCursor(value string, f Filters) (*cursor, error) {
	if !base64URL.MatchString(value) {
		return nil, errMalformedCursor
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(value, "="))
	if err != nil {
		return nil, errMalformedCursor
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var c cursor
	if dec.Decode(&c) != nil || c.Version != 2 || c.ReportID == "" || len(c.VersionStatuses) == 0 ||
		c.LastAction.RiskRank < 0 || c.LastAction.RiskRank >= len(ActionableStatuses) || c.LastAction.GroupKey == "" ||
		!slices.Contains([]string{tagUpdate, chartUpdate, review}, c.LastAction.ActionType) {
		return nil, errMalformedCursor
	}
	if canonical, err := normaliseStatuses(c.VersionStatuses); err != nil || !slices.Equal(canonical, c.VersionStatuses) {
		return nil, errMalformedCursor
	}
	if !equalPtr(c.Namespace, f.Namespace) || !slices.Equal(c.VersionStatuses, f.VersionStatuses) {
		return nil, errCursorFilters
	}

	return &c, nil
}

func equalPtr(a, b *string) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}

// normaliseStatuses rejects empty, duplicate or unknown statuses and returns
// them in canonical order.
func normaliseStatuses(statuses []string) ([]string, error) {
	if statuses == nil {
		return slices.Clone(ActionableStatuses), nil
	}
	seen := map[string]bool{}
	for _, s := range statuses {
		if seen[s] {
			return nil, errors.New("versionStatuses must contain one or more unique actionable statuses")
		}
		seen[s] = true
		if riskRank(s) < 0 {
			return nil, errors.New("versionStatuses must use: " + strings.Join(ActionableStatuses, ", "))
		}
	}
	if len(statuses) == 0 {
		return nil, errors.New("versionStatuses must contain one or more unique actionable statuses")
	}

	return slices.DeleteFunc(slices.Clone(ActionableStatuses), func(s string) bool { return !seen[s] }), nil
}

type ImageReference struct {
	Reference  string  `json:"reference"`
	Registry   string  `json:"registry"`
	Repository string  `json:"repository"`
	Tag        *string `json:"tag"`
}

func imageReference(registry, repository string, tag *string) ImageReference {
	ref := registry + "/" + repository
	if tag != nil && *tag != "" {
		ref += ":" + *tag
	}

	return ImageReference{Reference: ref, Registry: registry, Repository: repository, Tag: tag}
}

type WorkloadIdentity struct {
	GroupKey  string  `json:"groupKey"`
	Kind      *string `json:"kind"`
	Namespace *string `json:"namespace"`
	Name      *string `json:"name"`
}

type Evidence struct {
	Workload      WorkloadIdentity `json:"workload"`
	ContainerName *string          `json:"containerName"`
	CurrentImage  ImageReference   `json:"currentImage"`
	ProposedImage ImageReference   `json:"proposedImage"`
	VersionStatus string           `json:"versionStatus"`
}

// Action is an image_tag_update, a helm_chart_update or a manual_review.
// Fields that do not apply to its type are omitted.
type Action struct {
	ActionID      string `json:"actionId"`
	Type          string `json:"type"`
	VersionStatus string `json:"versionStatus"`
	// image_tag_update
	Workload      *WorkloadIdentity `json:"workload,omitempty"`
	ContainerName *string           `json:"containerName,omitempty"`
	CurrentImage  *ImageReference   `json:"currentImage,omitempty"`
	ProposedImage *ImageReference   `json:"proposedImage,omitempty"`
	// helm_chart_update and manual_review
	Reason                  string     `json:"reason,omitempty"`
	ReleaseGroupKey         string     `json:"releaseGroupKey,omitempty"`
	ReleaseName             *string    `json:"releaseName,omitempty"`
	ReleaseNamespace        *string    `json:"releaseNamespace,omitempty"`
	ChartName               *string    `json:"chartName,omitempty"`
	ObservedChartVersion    *string    `json:"observedChartVersion,omitempty"`
	LatestKnownChartVersion *string    `json:"latestKnownChartVersion,omitempty"`
	ImageEvidence           []Evidence `json:"imageEvidence,omitempty"`
	TotalImageCandidates    *int       `json:"totalImageCandidates,omitempty"`
	OmittedImageCandidates  *int       `json:"omittedImageCandidates,omitempty"`
}

type Summary struct {
	UniqueImageCandidates int `json:"uniqueImageCandidates"`
	TotalActions          int `json:"totalActions"`
	ImageTagUpdates       int `json:"imageTagUpdates"`
	HelmChartUpdates      int `json:"helmChartUpdates"`
	ManualReviews         int `json:"manualReviews"`
}

// Plan is advisory. Its scope is always present, so an empty plan is never
// ambiguous between "nothing is behind" and "you may not see it".
type Plan struct {
	// ok or no_ready_report.
	Status     string         `json:"status"`
	Filters    Filters        `json:"filters"`
	Snapshot   *Snapshot      `json:"snapshot"`
	Summary    Summary        `json:"summary"`
	Actions    []Action       `json:"actions"`
	NextCursor *string        `json:"nextCursor"`
	Warnings   []string       `json:"warnings"`
	Scope      tenancy.Notice `json:"scope"`
}

type PlanInput struct {
	Namespace       string
	VersionStatuses []string
	Limit           int
	Cursor          string
}

// Planner proposes image-tag and Helm-chart updates from the latest ready
// in-cluster report.
type Planner struct {
	Client       *Client
	Rows         *RowLoader
	DefaultLimit int
	MaximumLimit int
}

// row is an actionable image usage: behind by a requested status, with a
// tag to move to.
type row struct {
	ImageUsage
	versionStatus string
	latestTag     string
	releaseInfo   *string
}

func (r row) directKey() string {
	return jsonKey(r.WorkloadGroupKey, r.ContainerName, r.Registry, r.Repository, r.DeployedTag, r.LatestTag)
}

type group struct {
	SortKey
	rows    []row
	release *ReleaseInfo
}

func minText(values []*string) *string {
	var out *string
	for _, v := range values {
		if v != nil && (out == nil || *v < *out) {
			out = v
		}
	}

	return out
}

func (p *Planner) Plan(ctx context.Context, in PlanInput, scope tenancy.Scope) (*Plan, error) {
	filters := Filters{}
	if in.Namespace != "" {
		ns := strings.TrimSpace(in.Namespace)
		if ns == "" {
			return nil, errors.New("namespace must be a non-empty string")
		}
		filters.Namespace = &ns
	}
	statuses, err := normaliseStatuses(in.VersionStatuses)
	if err != nil {
		return nil, err
	}
	filters.VersionStatuses = statuses
	limit := in.Limit
	if limit == 0 {
		limit = p.DefaultLimit
	}
	if limit < 1 {
		return nil, errors.New("limit must be a positive integer")
	}
	limit = min(limit, p.MaximumLimit)

	var cur *cursor
	if in.Cursor != "" {
		if cur, err = decodeCursor(in.Cursor, filters); err != nil {
			return nil, err
		}
	}

	var snapshot *ReportSnapshot
	if cur != nil {
		if snapshot, err = p.Client.InClusterReport(ctx, cur.ReportID); err != nil {
			return nil, err
		}
		if snapshot == nil {
			return nil, errors.New("cursor report is no longer an eligible ready snapshot")
		}
	} else if snapshot, err = p.Client.LatestInClusterReport(ctx); err != nil {
		return nil, err
	}
	if snapshot == nil {
		return &Plan{Status: "no_ready_report", Filters: filters, Actions: []Action{}, Warnings: slices.Clone(planWarnings), Scope: tenancy.Describe(scope, 0)}, nil
	}

	rows, err := p.Rows.Load(ctx, snapshot.ReportID)
	if err != nil {
		return nil, err
	}
	var actionable []row
	for _, u := range rows.ImageUsages {
		if u.LatestTag == nil || u.VersionStatus == nil || !slices.Contains(statuses, *u.VersionStatus) || !inScope(&u, scope) ||
			(filters.Namespace != nil && (u.WorkloadNamespace == nil || *u.WorkloadNamespace != *filters.Namespace)) {
			continue
		}
		actionable = append(actionable, row{ImageUsage: u, versionStatus: *u.VersionStatus, latestTag: *u.LatestTag, releaseInfo: rows.ReleaseInfoFor(u.ReleaseGroupKey)})
	}

	direct, helm := buildGroups(actionable)
	summary := Summary{ImageTagUpdates: len(direct)}
	unique := map[string]bool{}
	for _, r := range actionable {
		unique[r.directKey()] = true
	}
	summary.UniqueImageCandidates = len(unique)
	for _, g := range helm {
		if g.ActionType == chartUpdate {
			summary.HelmChartUpdates++
		} else {
			summary.ManualReviews++
		}
	}
	summary.TotalActions = summary.ImageTagUpdates + summary.HelmChartUpdates + summary.ManualReviews

	all := slices.Concat(direct, helm)
	slices.SortFunc(all, func(a, b *group) int { return a.compare(b.SortKey) })
	if cur != nil {
		all = slices.DeleteFunc(all, func(g *group) bool { return g.compare(cur.LastAction) <= 0 })
	}
	hasMore := len(all) > limit
	if hasMore {
		all = all[:limit]
	}

	plan := &Plan{Status: "ok", Filters: filters, Snapshot: &Snapshot{ReportID: snapshot.ReportID, CreatedAt: snapshot.CreatedAt},
		Summary: summary, Actions: []Action{}, Warnings: slices.Clone(planWarnings), Scope: tenancy.Describe(scope, summary.TotalActions)}
	for _, g := range all {
		action, err := g.action(snapshot.ReportID)
		if err != nil {
			return nil, err
		}
		plan.Actions = append(plan.Actions, action)
	}
	if hasMore && len(all) > 0 {
		next := encodeCursor(snapshot.ReportID, filters, all[len(all)-1].SortKey)
		plan.NextCursor = &next
	}

	return plan, nil
}

// buildGroups groups rows outside a Helm release per image identity, so one
// action covers every replica of the same container on the same tag, and
// Helm-managed rows per release, since bumping the chart is one action.
func buildGroups(rows []row) (direct, helm []*group) {
	byKey := map[string]*group{}
	var order []string
	for _, r := range rows {
		key := r.directKey()
		if r.ReleaseGroupKey != nil {
			key = "helm\x00" + jsonKey(*r.ReleaseGroupKey, r.releaseInfo)
		}
		g := byKey[key]
		if g == nil {
			g = &group{}
			byKey[key] = g
			order = append(order, key)
		}
		g.rows = append(g.rows, r)
	}
	for _, key := range order {
		g := byKey[key]
		first := g.rows[0]
		g.RiskRank = len(ActionableStatuses)
		var namespaces []*string
		for _, r := range g.rows {
			g.RiskRank = min(g.RiskRank, riskRank(r.versionStatus))
			namespaces = append(namespaces, r.WorkloadNamespace)
		}
		if first.ReleaseGroupKey == nil {
			g.ActionType, g.GroupKey, g.Namespace = tagUpdate, key, deref(minText(namespaces))
			direct = append(direct, g)

			continue
		}
		g.release = ParseReleaseInfo(first.releaseInfo)
		g.GroupKey = *first.ReleaseGroupKey
		g.Namespace = deref(minText(namespaces))
		if g.release != nil && g.release.Namespace != nil {
			g.Namespace = *g.release.Namespace
		}
		// A chart update is proposable only when the release names the
		// version it runs and a different one to move to.
		g.ActionType = review
		if g.release != nil {
			observed, latest := chartVersion(g.release.ChartVersion), chartVersion(g.release.LatestChartTag)
			if observed != "" && latest != "" && observed != latest {
				g.ActionType = chartUpdate
			}
		}
		helm = append(helm, g)
	}

	return direct, helm
}

// chartVersion treats v1.2.3 and 1.2.3 as the same version, as chart tags
// are written inconsistently.
func chartVersion(v *string) string {
	return strings.TrimPrefix(strings.TrimSpace(deref(v)), "v")
}

func (g *group) actionID(reportID string) string {
	sum := sha256.Sum256([]byte(jsonKey(reportID, g.ActionType, g.Namespace, g.GroupKey)))

	return hex.EncodeToString(sum[:])
}

func (g *group) action(reportID string) (Action, error) {
	a := Action{ActionID: g.actionID(reportID), Type: g.ActionType, VersionStatus: ActionableStatuses[g.RiskRank]}
	if g.ActionType == tagUpdate {
		r := g.rows[0]
		var kinds, names []*string
		for _, row := range g.rows {
			kinds, names = append(kinds, row.WorkloadKind), append(names, row.WorkloadName)
		}
		namespace := g.Namespace
		ns := &namespace
		if namespace == "" {
			ns = nil
		}
		current, proposed := imageReference(r.Registry, r.Repository, r.DeployedTag), imageReference(r.Registry, r.Repository, &r.latestTag)
		a.Workload = &WorkloadIdentity{GroupKey: r.WorkloadGroupKey, Kind: minText(kinds), Namespace: ns, Name: minText(names)}
		a.ContainerName, a.CurrentImage, a.ProposedImage = r.ContainerName, &current, &proposed

		return a, nil
	}

	// The first parseable release info among the group's rows.
	info := g.release
	evidence := g.evidence()
	total, omitted := len(evidence), max(0, len(evidence)-maxEvidence)
	if len(evidence) > maxEvidence {
		evidence = evidence[:maxEvidence]
	}
	a.ReleaseGroupKey, a.ImageEvidence, a.TotalImageCandidates, a.OmittedImageCandidates = g.GroupKey, evidence, &total, &omitted
	var observed, latest *string
	if info != nil {
		a.ReleaseName, a.ReleaseNamespace, a.ChartName = info.Name, info.Namespace, info.ChartName
		observed, latest = versionCandidate(info.ChartVersion), versionCandidate(info.LatestChartTag)
	}
	if g.ActionType == chartUpdate {
		if observed == nil || latest == nil {
			return Action{}, errors.New("Helm chart update group is missing a usable chart version candidate") //nolint:staticcheck // Helm is a proper noun.
		}
	} else {
		a.Reason = "missing_chart_candidate"
		if observed != nil && latest != nil {
			a.Reason = "chart_candidate_not_distinct"
		}
	}
	a.ObservedChartVersion, a.LatestKnownChartVersion = observed, latest

	return a, nil
}

func versionCandidate(v *string) *string {
	raw := strings.TrimSpace(deref(v))
	if raw == "" || strings.TrimPrefix(raw, "v") == "" {
		return nil
	}

	return &raw
}

// evidence keeps one entry per image identity, the riskiest, sorted by
// namespace, workload, container and references.
func (g *group) evidence() []Evidence {
	byKey := map[string]Evidence{}
	var order []string
	rows := slices.Clone(g.rows)
	slices.SortStableFunc(rows, func(a, b row) int {
		for _, c := range []int{strings.Compare(a.WorkloadGroupKey, b.WorkloadGroupKey), compareNullable(a.ContainerName, b.ContainerName),
			strings.Compare(a.Repository, b.Repository)} {
			if c != 0 {
				return c
			}
		}

		return 0
	})
	for _, r := range rows {
		e := Evidence{
			Workload:      WorkloadIdentity{GroupKey: r.WorkloadGroupKey, Kind: r.WorkloadKind, Namespace: r.WorkloadNamespace, Name: r.WorkloadName},
			ContainerName: r.ContainerName,
			CurrentImage:  imageReference(r.Registry, r.Repository, r.DeployedTag),
			ProposedImage: imageReference(r.Registry, r.Repository, &r.latestTag),
			VersionStatus: r.versionStatus,
		}
		key := r.directKey()
		existing, ok := byKey[key]
		if !ok {
			order = append(order, key)
		}
		if !ok || riskRank(e.VersionStatus) < riskRank(existing.VersionStatus) {
			byKey[key] = e
		}
	}
	out := make([]Evidence, 0, len(order))
	for _, k := range order {
		out = append(out, byKey[k])
	}
	slices.SortStableFunc(out, func(a, b Evidence) int {
		for _, c := range []int{
			compareFold(deref(a.Workload.Namespace), deref(b.Workload.Namespace)), compareFold(a.Workload.GroupKey, b.Workload.GroupKey),
			compareFold(deref(a.ContainerName), deref(b.ContainerName)), compareFold(a.CurrentImage.Reference, b.CurrentImage.Reference),
			compareFold(a.ProposedImage.Reference, b.ProposedImage.Reference),
		} {
			if c != 0 {
				return c
			}
		}

		return 0
	})

	return out
}
