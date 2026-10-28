package backend

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"github.com/codemowers/driftmower-mcp/internal/tenancy"
)

const reportID = "report-1"

type planUsage struct {
	group, namespace, container, repository, versionStatus string
	release                                                any
	latestTag                                              any
}

func planRow(u planUsage) Row {
	def := func(v, d string) string {
		if v == "" {
			return d
		}

		return v
	}
	parts := strings.Split(u.group, ":")
	r := Row{"reportId": reportID, "workloadGroupKey": u.group, "workloadKind": "Deployment", "workloadNamespace": def(u.namespace, "apps"),
		"workloadName": parts[len(parts)-1], "releaseGroupKey": u.release, "containerName": def(u.container, "main"), "registry": "registry.example",
		"repository": def(u.repository, "example/api"), "deployedTag": "1.0.0", "latestTag": "2.0.0", "status": "outdated", "versionStatus": nil}
	if u.versionStatus != "" {
		r["versionStatus"] = u.versionStatus
	}
	if u.latestTag != nil {
		r["latestTag"] = u.latestTag
	}

	return r
}

func planner(t *testing.T, usages, scores []Row, limit int) (*Planner, *Client) {
	t.Helper()
	_, c := fake(t, map[string][]Row{
		"reports":        {report(reportID, "in-cluster", "2026-08-01T12:00:00.000Z", nil)},
		"image-usages":   usages,
		"release-scores": scores,
	})

	return &Planner{Client: c, Rows: &RowLoader{Client: c}, DefaultLimit: limit, MaximumLimit: 100}, c
}

func byType(p *Plan, typ string) []Action {
	var out []Action
	for _, a := range p.Actions {
		if a.Type == typ {
			out = append(out, a)
		}
	}

	return out
}

func TestPlanDeduplicatesDirectReplicas(t *testing.T) {
	p, _ := planner(t, []Row{
		planRow(planUsage{group: "deployment:apps:api", versionStatus: "minor_behind"}),
		planRow(planUsage{group: "deployment:apps:api", versionStatus: "minor_behind"}),
		planRow(planUsage{group: "deployment:apps:api", container: "sidecar", repository: "example/sidecar", versionStatus: "patch_behind"}),
		planRow(planUsage{group: "deployment:apps:ignored", latestTag: json.RawMessage("null"), versionStatus: "major_behind"}),
		planRow(planUsage{group: "deployment:apps:current", versionStatus: "up_to_date"}),
	}, nil, 20)
	plan, err := p.Plan(ctx, PlanInput{}, tenancy.UnrestrictedScope)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Actions) != 2 || plan.Actions[0].VersionStatus != "minor_behind" || *plan.Actions[0].ContainerName != "main" ||
		plan.Actions[1].VersionStatus != "patch_behind" || *plan.Actions[1].ContainerName != "sidecar" {
		t.Errorf("actions = %+v", plan.Actions)
	}
	if plan.Summary != (Summary{UniqueImageCandidates: 2, TotalActions: 2, ImageTagUpdates: 2}) {
		t.Errorf("summary = %+v", plan.Summary)
	}
}

func helmFixture() ([]Row, []Row) {
	return []Row{
			planRow(planUsage{group: "deployment:apps:chart", release: "helm/apps/chart", versionStatus: "patch_behind"}),
			planRow(planUsage{group: "deployment:apps:chart-worker", release: "helm/apps/chart", repository: "example/worker", versionStatus: "major_behind"}),
			planRow(planUsage{group: "deployment:apps:equal", release: "helm/apps/equal", versionStatus: "minor_behind"}),
			planRow(planUsage{group: "deployment:other:missing", namespace: "other", release: "helm/other/missing", versionStatus: "behind"}),
		}, []Row{
			release(reportID, "helm/apps/chart", map[string]any{"name": "chart", "namespace": "apps", "chartName": "example-chart", "chartVersion": "v1.0.0", "latestChartTag": "1.1.0"}),
			// Same version written two ways: nothing to update.
			release(reportID, "helm/apps/equal", map[string]any{"name": "equal", "namespace": "apps", "chartVersion": "v2.0.0", "latestChartTag": "2.0.0"}),
			// No candidate at all: a human has to decide.
			release(reportID, "helm/other/missing", map[string]any{"name": "missing", "namespace": "other", "chartVersion": "3.0.0"}),
		}
}

func TestPlanConsolidatesHelmReleases(t *testing.T) {
	usages, scores := helmFixture()
	p, _ := planner(t, usages, scores, 20)
	plan, err := p.Plan(ctx, PlanInput{}, tenancy.UnrestrictedScope)
	if err != nil {
		t.Fatal(err)
	}
	want := [][3]string{
		// The riskiest image in a release decides its risk.
		{"helm_chart_update", "helm/apps/chart", "major_behind"},
		{"manual_review", "helm/apps/equal", "minor_behind"},
		{"manual_review", "helm/other/missing", "behind"},
	}
	for i, w := range want {
		a := plan.Actions[i]
		if a.Type != w[0] || a.ReleaseGroupKey != w[1] || a.VersionStatus != w[2] {
			t.Errorf("action %d = %s %s %s", i, a.Type, a.ReleaseGroupKey, a.VersionStatus)
		}
	}
	if plan.Actions[1].Reason != "chart_candidate_not_distinct" || plan.Actions[2].Reason != "missing_chart_candidate" {
		t.Errorf("reasons = %q %q", plan.Actions[1].Reason, plan.Actions[2].Reason)
	}
	if plan.Summary != (Summary{UniqueImageCandidates: 4, TotalActions: 3, HelmChartUpdates: 1, ManualReviews: 2}) {
		t.Errorf("summary = %+v", plan.Summary)
	}
	apps, _ := p.Plan(ctx, PlanInput{Namespace: "apps"}, tenancy.UnrestrictedScope)
	if apps.Summary != (Summary{UniqueImageCandidates: 3, TotalActions: 2, HelmChartUpdates: 1, ManualReviews: 1}) {
		t.Errorf("apps summary = %+v", apps.Summary)
	}
}

func TestPlanContinuesAfterSortKey(t *testing.T) {
	p, _ := planner(t, []Row{
		planRow(planUsage{group: "deployment:apps:alpha", repository: "example/alpha", versionStatus: "minor_behind"}),
		planRow(planUsage{group: "deployment:apps:beta", repository: "example/beta", versionStatus: "minor_behind"}),
		planRow(planUsage{group: "deployment:apps:gamma", repository: "example/gamma", versionStatus: "patch_behind"}),
	}, nil, 2)
	first, _ := p.Plan(ctx, PlanInput{}, tenancy.UnrestrictedScope)
	if len(first.Actions) != 2 || first.NextCursor == nil {
		t.Fatalf("first page = %+v", first)
	}
	second, err := p.Plan(ctx, PlanInput{Cursor: *first.NextCursor}, tenancy.UnrestrictedScope)
	if err != nil || len(second.Actions) != 1 || second.Actions[0].Workload.GroupKey != "deployment:apps:gamma" ||
		second.Actions[0].VersionStatus != "patch_behind" || second.NextCursor != nil {
		t.Errorf("second page = %+v %v", second, err)
	}
}

func TestPlanReadsReportOnce(t *testing.T) {
	b, c := fake(t, map[string][]Row{
		"reports":      {report(reportID, "in-cluster", "2026-08-01", nil)},
		"image-usages": {planRow(planUsage{group: "deployment:apps:api", versionStatus: "behind"})},
	})
	p := &Planner{Client: c, Rows: &RowLoader{Client: c}, DefaultLimit: 20, MaximumLimit: 100}
	_, _ = p.Plan(ctx, PlanInput{}, tenancy.UnrestrictedScope)
	_, _ = p.Plan(ctx, PlanInput{}, tenancy.UnrestrictedScope)
	// A ready report is immutable: every question shares one read.
	if n := len(b.RequestsTo("image-usages")); n != 1 {
		t.Errorf("image-usages requests = %d", n)
	}
}

func TestPlanValidatesBeforeQuerying(t *testing.T) {
	b, c := fake(t, nil)
	p := &Planner{Client: c, Rows: &RowLoader{Client: c}, DefaultLimit: 20, MaximumLimit: 100}
	if _, err := p.Plan(ctx, PlanInput{VersionStatuses: []string{"major_behind", "major_behind"}}, tenancy.UnrestrictedScope); err == nil ||
		err.Error() != "versionStatuses must contain one or more unique actionable statuses" {
		t.Errorf("duplicate statuses err = %v", err)
	}
	if _, err := p.Plan(ctx, PlanInput{Limit: -1}, tenancy.UnrestrictedScope); err == nil || err.Error() != "limit must be a positive integer" {
		t.Errorf("limit err = %v", err)
	}
	if len(b.Requests()) != 0 {
		t.Errorf("requests = %v", b.Requests())
	}
}

func TestPlanNoReadyReport(t *testing.T) {
	_, c := fake(t, nil)
	p := &Planner{Client: c, Rows: &RowLoader{Client: c}, DefaultLimit: 20, MaximumLimit: 100}
	plan, err := p.Plan(ctx, PlanInput{Namespace: " apps "}, tenancy.UnrestrictedScope)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := json.Marshal(plan)
	for _, want := range []string{`"status":"no_ready_report"`, `"filters":{"namespace":"apps","versionStatuses":["major_behind","minor_behind","patch_behind","behind"]}`,
		`"snapshot":null`, `"summary":{"uniqueImageCandidates":0,"totalActions":0,"imageTagUpdates":0,"helmChartUpdates":0,"manualReviews":0}`,
		`"actions":[]`, `"nextCursor":null`} {
		if !strings.Contains(string(got), want) {
			t.Errorf("plan %s lacks %s", got, want)
		}
	}
	if len(plan.Warnings) != 2 {
		t.Errorf("warnings = %v", plan.Warnings)
	}
}

func TestPlanMapsActionsWithBoundedEvidence(t *testing.T) {
	usages := []Row{planRow(planUsage{group: "deployment:apps:api", versionStatus: "minor_behind"})}
	for i := range 12 {
		status := "minor_behind"
		if i == 0 {
			status = "major_behind"
		}
		usages = append(usages, planRow(planUsage{group: "deployment:apps:workload-" + string(rune('a'+i)), release: "helm/apps/chart",
			repository: "example/image-" + string(rune('a'+i)), versionStatus: status}))
	}
	usages = append(usages, planRow(planUsage{group: "deployment:apps:equal", release: "helm/apps/equal", versionStatus: "minor_behind"}))
	scores := []Row{
		release(reportID, "helm/apps/chart", map[string]any{"name": "chart", "namespace": "apps", "chartName": "example-chart", "chartVersion": "v1.0.0", "latestChartTag": "1.1.0"}),
		release(reportID, "helm/apps/equal", map[string]any{"name": "equal", "namespace": "apps", "chartName": "equal-chart", "chartVersion": "v2.0.0", "latestChartTag": "2.0.0"}),
	}
	p, _ := planner(t, usages, scores, 20)
	first, err := p.Plan(ctx, PlanInput{}, tenancy.UnrestrictedScope)
	if err != nil {
		t.Fatal(err)
	}
	second, _ := p.Plan(ctx, PlanInput{}, tenancy.UnrestrictedScope)

	direct := byType(first, "image_tag_update")[0]
	if direct.Workload.GroupKey != "deployment:apps:api" || *direct.Workload.Namespace != "apps" || *direct.Workload.Name != "api" ||
		*direct.ContainerName != "main" || direct.CurrentImage.Reference != "registry.example/example/api:1.0.0" ||
		direct.ProposedImage.Reference != "registry.example/example/api:2.0.0" || direct.VersionStatus != "minor_behind" {
		t.Errorf("direct = %+v", direct)
	}
	chart := byType(first, "helm_chart_update")[0]
	if chart.VersionStatus != "major_behind" || chart.ReleaseGroupKey != "helm/apps/chart" || *chart.ObservedChartVersion != "v1.0.0" ||
		*chart.LatestKnownChartVersion != "1.1.0" || *chart.TotalImageCandidates != 12 || *chart.OmittedImageCandidates != 2 || len(chart.ImageEvidence) != 10 {
		t.Errorf("chart = %+v", chart)
	}
	manual := byType(first, "manual_review")[0]
	if manual.Reason != "chart_candidate_not_distinct" || manual.ReleaseGroupKey != "helm/apps/equal" ||
		*manual.ObservedChartVersion != "v2.0.0" || *manual.LatestKnownChartVersion != "2.0.0" {
		t.Errorf("manual = %+v", manual)
	}
	for i := range first.Actions {
		if first.Actions[i].ActionID != second.Actions[i].ActionID {
			t.Error("action IDs are not stable")
		}
	}
}

func TestPlanPinsCursorReport(t *testing.T) {
	b, c := fake(t, map[string][]Row{
		"reports": {report(reportID, "in-cluster", "2026-08-01T12:00:00.000Z", nil)},
		"image-usages": {
			planRow(planUsage{group: "deployment:apps:api", versionStatus: "minor_behind"}),
			planRow(planUsage{group: "deployment:apps:worker", repository: "example/worker", versionStatus: "minor_behind"}),
		},
	})
	p := &Planner{Client: c, Rows: &RowLoader{Client: c}, DefaultLimit: 1, MaximumLimit: 100}
	first, _ := p.Plan(ctx, PlanInput{}, tenancy.UnrestrictedScope)
	if first.NextCursor == nil {
		t.Fatal("no cursor")
	}
	b.SetRows("reports", []Row{
		report(reportID, "in-cluster", "2026-08-01T12:00:00.000Z", nil),
		report("report-2", "in-cluster", "2026-08-02T12:00:00.000Z", nil),
	})
	second, err := p.Plan(ctx, PlanInput{Cursor: *first.NextCursor}, tenancy.UnrestrictedScope)
	if err != nil || second.Snapshot.ReportID != reportID || len(second.Actions) != 1 || second.Actions[0].Workload.GroupKey != "deployment:apps:worker" {
		t.Errorf("second = %+v %v", second, err)
	}

	b.SetRows("reports", []Row{report("report-2", "in-cluster", "2026-08-02T12:00:00.000Z", nil)})
	if _, err := p.Plan(ctx, PlanInput{Cursor: *first.NextCursor}, tenancy.UnrestrictedScope); err == nil ||
		err.Error() != "cursor report is no longer an eligible ready snapshot" {
		t.Errorf("vanished report err = %v", err)
	}
}

var cursorFilters = Filters{Namespace: str("apps"), VersionStatuses: []string{"major_behind", "minor_behind"}}

func encodePayload(v any) string {
	b, _ := json.Marshal(v)

	return base64.RawURLEncoding.EncodeToString(b)
}

func TestCursorRoundTrip(t *testing.T) {
	last := SortKey{RiskRank: 1, ActionType: "image_tag_update", Namespace: "apps", GroupKey: "group-1"}
	c, err := decodeCursor(encodeCursor("report-1", cursorFilters, last), cursorFilters)
	if err != nil || c.Version != 2 || c.ReportID != "report-1" || *c.Namespace != "apps" || c.LastAction != last ||
		strings.Join(c.VersionStatuses, ",") != "major_behind,minor_behind" {
		t.Errorf("cursor = %+v %v", c, err)
	}
}

func TestCursorRejectsMalformed(t *testing.T) {
	last := map[string]any{"riskRank": 0, "actionType": "image_tag_update", "namespace": "apps", "groupKey": "group-1"}
	for name, value := range map[string]string{
		"not base64": "not valid base64!",
		"duplicate": encodePayload(map[string]any{"version": 2, "reportId": "report-1", "namespace": "apps",
			"versionStatuses": []string{"major_behind", "major_behind"}, "lastAction": last}),
		"wrong order": encodePayload(map[string]any{"version": 2, "reportId": "report-1", "namespace": "apps",
			"versionStatuses": []string{"minor_behind", "major_behind"}, "lastAction": last}),
		// Obsolete version-one cursors carried the cluster.
		"version one": encodePayload(map[string]any{"version": 1, "reportId": "report-1", "cluster": "in-cluster", "namespace": "apps",
			"versionStatuses": []string{"major_behind", "minor_behind"}, "lastAction": last}),
	} {
		if _, err := decodeCursor(value, cursorFilters); err == nil || err.Error() != "cursor is malformed" {
			t.Errorf("%s: err = %v", name, err)
		}
	}
}

func TestCursorRejectsChangedFilters(t *testing.T) {
	c := encodeCursor("report-1", cursorFilters, SortKey{RiskRank: 1, ActionType: "manual_review", Namespace: "apps", GroupKey: "group-1"})
	for _, f := range []Filters{{VersionStatuses: cursorFilters.VersionStatuses}, {Namespace: str("apps"), VersionStatuses: []string{"major_behind"}}} {
		if _, err := decodeCursor(c, f); err == nil || err.Error() != "cursor does not match the requested filters" {
			t.Errorf("filters %+v: err = %v", f, err)
		}
	}
}
