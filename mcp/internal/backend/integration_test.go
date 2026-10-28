package backend

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/codemowers/driftmower-mcp/internal/authz"
	"github.com/codemowers/driftmower-mcp/internal/tenancy"
	"github.com/codemowers/driftmower-mcp/internal/testutil/fakebackend"
)

// These drive the services against rows recorded from a real full-cluster
// analysis, served over the same HTTP path production uses.

const fixtureReportID = "0b249694-625d-41c8-a788-5b207c9c4d6b"

func recorded(t *testing.T) (*Searcher, *Planner) {
	t.Helper()
	c := clientFor(fakebackend.New(t, nil))
	rows := &RowLoader{Client: c}

	return &Searcher{Client: c, Rows: rows, DefaultLimit: 20, MaximumLimit: 100},
		&Planner{Client: c, Rows: rows, DefaultLimit: 20, MaximumLimit: 100}
}

func TestRecordedPlan(t *testing.T) {
	_, p := recorded(t)
	plan, err := p.Plan(ctx, PlanInput{Limit: 100}, tenancy.UnrestrictedScope)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Status != "ok" || plan.Snapshot.ReportID != fixtureReportID || plan.Snapshot.CreatedAt != "2026-07-13 20:14:51" ||
		plan.Filters.Namespace != nil || plan.NextCursor != nil {
		t.Fatalf("plan = %+v", plan)
	}
	s := plan.Summary
	if s.ImageTagUpdates == 0 || s.HelmChartUpdates == 0 || s.ManualReviews == 0 || s.TotalActions != len(plan.Actions) {
		t.Errorf("summary = %+v, actions %d", s, len(plan.Actions))
	}
	direct := byType(plan, "image_tag_update")[0]
	if direct.CurrentImage.Tag == nil || direct.ProposedImage.Tag == nil {
		t.Errorf("direct = %+v", direct)
	}
	var helm *Action
	for _, a := range byType(plan, "helm_chart_update") {
		if a.ReleaseName != nil && *a.ReleaseName == "cert-manager" {
			helm = &a
		}
	}
	if helm == nil || *helm.ReleaseNamespace != "cert-manager" || *helm.ChartName != "cert-manager" ||
		*helm.ObservedChartVersion != "v1.20.0" || *helm.LatestKnownChartVersion != "1.21.0" {
		t.Fatalf("cert-manager action = %+v", helm)
	}
	if e := helm.ImageEvidence[0].ProposedImage; e.Repository != "jetstack/cert-manager-controller" || *e.Tag != "v1.21.0" {
		t.Errorf("evidence = %+v", e)
	}
	if r := byType(plan, "manual_review")[0].Reason; r != "missing_chart_candidate" && r != "chart_candidate_not_distinct" {
		t.Errorf("manual reason = %q", r)
	}
	raw, _ := json.Marshal(plan)
	if strings.Contains(string(raw), "chartTags") || strings.Contains(string(raw), "release_info") {
		t.Error("raw release info leaked into the plan")
	}
}

func TestRecordedPlanContinuation(t *testing.T) {
	_, p := recorded(t)
	first, err := p.Plan(ctx, PlanInput{Limit: 2}, tenancy.UnrestrictedScope)
	if err != nil || first.NextCursor == nil {
		t.Fatalf("first = %+v %v", first, err)
	}
	second, err := p.Plan(ctx, PlanInput{Limit: 2, Cursor: *first.NextCursor}, tenancy.UnrestrictedScope)
	if err != nil || second.Snapshot.ReportID != fixtureReportID {
		t.Fatalf("second = %+v %v", second, err)
	}
	for _, a := range second.Actions {
		if slices.ContainsFunc(first.Actions, func(f Action) bool { return f.ActionID == a.ActionID }) {
			t.Errorf("action %s repeated", a.ActionID)
		}
	}
}

func TestRecordedSearch(t *testing.T) {
	s, _ := recorded(t)
	r, err := s.Search(ctx, "cert-manager", 1, tenancy.UnrestrictedScope)
	if err != nil || len(r.Matches) != 1 {
		t.Fatalf("result = %+v %v", r, err)
	}
	m := r.Matches[0]
	if *m.Name != "cert-manager" || *m.Kind != "Deployment" || *m.Namespace != "cert-manager" || *m.Analysis.Status != "minor_behind" ||
		m.Snapshot != (Snapshot{ReportID: fixtureReportID, CreatedAt: "2026-07-13 20:14:51"}) {
		t.Errorf("match = %+v", m)
	}
	h := m.Analysis.Helm
	if h == nil || *h.ReleaseName != "cert-manager" || *h.ReleaseNamespace != "cert-manager" || *h.ChartName != "cert-manager" ||
		*h.ObservedChartVersion != "v1.20.0" || *h.LatestKnownChartVersion != "1.21.0" || *h.AppVersion != "v1.20.0" {
		t.Errorf("helm = %+v", h)
	}
	img := m.Analysis.Images
	if len(img) != 1 || img[0].Registry != "quay.io" || img[0].Repository != "jetstack/cert-manager-controller" ||
		*img[0].ObservedTag != "v1.20.0" || *img[0].LatestKnownTag != "v1.21.0" || *img[0].VersionStatus != "minor_behind" {
		t.Errorf("images = %+v", img)
	}

	r, _ = s.Search(ctx, "alertmanager", 1, tenancy.UnrestrictedScope)
	if len(r.Matches) != 1 || *r.Matches[0].Name != "alertmanager" || r.Matches[0].Analysis.Helm != nil {
		t.Fatalf("alertmanager = %+v", r.Matches)
	}
	var repos []string
	for _, i := range r.Matches[0].Analysis.Images {
		repos = append(repos, i.Repository)
	}
	if !slices.Equal(repos, []string{"prometheus-operator/prometheus-config-reloader", "prometheus/alertmanager"}) {
		t.Errorf("repositories = %v", repos)
	}
}

func claim(namespaces ...string) tenancy.Scope {
	return tenancy.FromClaimOnly(tenancy.Claim{Namespaces: namespaces, Present: true})
}

var missingClaim = tenancy.FromClaimOnly(tenancy.Claim{})

func unionScope(claimed, rbac []string) tenancy.Scope {
	return tenancy.Merge(tenancy.Claim{Namespaces: claimed, Present: true}, authz.RBACScope{Namespaces: rbac, Unknown: []string{}}, nil, tenancy.PolicyUnion, "")
}

func inNamespace(r *SearchResult, ns string) bool {
	return !slices.ContainsFunc(r.Matches, func(m WorkloadMatch) bool { return m.Namespace == nil || *m.Namespace != ns })
}

func TestTenancySearch(t *testing.T) {
	s, _ := recorded(t)
	search := func(scope tenancy.Scope) *SearchResult {
		r, err := s.Search(ctx, "cert-manager", 0, scope)
		if err != nil {
			t.Fatal(err)
		}

		return r
	}

	if r := search(tenancy.UnrestrictedScope); len(r.Matches) == 0 || r.Scope.Scoped || r.Scope.Namespaces != nil || r.Scope.Note != "" {
		t.Errorf("unscoped = %+v", r.Scope)
	}
	// The authorizer grants a namespace the claim does not name.
	if r := search(unionScope([]string{}, []string{"cert-manager"})); len(r.Matches) == 0 || !inNamespace(r, "cert-manager") ||
		!r.Scope.Scoped || !slices.Equal(r.Scope.Namespaces, []string{"cert-manager"}) {
		t.Errorf("union = %+v", r)
	}
	// Withheld, and said so: an agent must not report "no such workload".
	if r := search(claim("memelord-laurivosandi")); len(r.Matches) != 0 || !r.Scope.Scoped || !strings.Contains(r.Scope.Note, "outside your access") {
		t.Errorf("outside = %+v", r.Scope)
	}
	if r := search(claim("cert-manager")); len(r.Matches) == 0 || !inNamespace(r, "cert-manager") {
		t.Errorf("inside = %+v", r.Matches)
	}
	if r := search(missingClaim); len(r.Matches) != 0 || !strings.Contains(r.Scope.Note, "no namespaces claim") {
		t.Errorf("missing claim = %+v", r.Scope)
	}
}

func TestTenancyPlan(t *testing.T) {
	_, p := recorded(t)
	plan := func(scope tenancy.Scope) *Plan {
		r, err := p.Plan(ctx, PlanInput{Limit: 100}, scope)
		if err != nil {
			t.Fatal(err)
		}

		return r
	}

	unscoped := plan(tenancy.UnrestrictedScope)
	if unscoped.Status != "ok" || unscoped.Summary.TotalActions == 0 || unscoped.Scope.Scoped {
		t.Errorf("unscoped = %+v", unscoped.Summary)
	}
	scoped := plan(claim("cert-manager"))
	if scoped.Summary.TotalActions >= unscoped.Summary.TotalActions || !slices.Equal(scoped.Scope.Namespaces, []string{"cert-manager"}) {
		t.Errorf("scoped = %+v %+v", scoped.Summary, scoped.Scope)
	}
	// Helm groups carry no namespace of their own; scoping their image rows
	// has to make the release disappear.
	if len(byType(unscoped, "helm_chart_update"))+len(byType(unscoped, "manual_review")) == 0 {
		t.Fatal("fixture has no Helm actions")
	}
	for _, a := range plan(claim("memelord-laurivosandi")).Actions {
		if a.Type != "image_tag_update" && a.ReleaseNamespace != nil && *a.ReleaseNamespace == "cert-manager" {
			t.Error("cert-manager release leaked outside the scope")
		}
	}
	if r := plan(missingClaim); r.Summary.TotalActions != 0 || len(r.Actions) != 0 || !strings.Contains(r.Scope.Note, "no namespaces claim") {
		t.Errorf("missing claim = %+v", r)
	}
}
