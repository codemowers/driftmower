package backend

import (
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/codemowers/driftmower/mcp/internal/tenancy"
)

type usageOpts struct {
	repository, container, namespace, versionStatus string
	release                                         any
	deployedTag, latestTag                          any
	status                                          string
}

func searchUsage(reportID, groupKey, name string, o usageOpts) Row {
	def := func(v, d string) string {
		if v == "" {
			return d
		}

		return v
	}
	r := Row{"reportId": reportID, "workloadGroupKey": groupKey, "workloadKind": "Deployment",
		"workloadNamespace": def(o.namespace, "apps"), "workloadName": name, "releaseGroupKey": o.release,
		"registry": "registry.example", "repository": def(o.repository, "example/workload"), "deployedTag": "1.0.0", "latestTag": "2.0.0",
		"status": def(o.status, "analyzed"), "versionStatus": def(o.versionStatus, "outdated"), "containerName": def(o.container, "main")}
	if o.deployedTag != nil {
		r["deployedTag"] = o.deployedTag
	}
	if o.latestTag != nil {
		r["latestTag"] = o.latestTag
	}

	return r
}

func searcher(c *Client, def, max int) *Searcher {
	return &Searcher{Client: c, Rows: &RowLoader{Client: c}, DefaultLimit: def, MaximumLimit: max}
}

func names(r *SearchResult) []string {
	var out []string
	for _, m := range r.Matches {
		out = append(out, deref(m.Name))
	}

	return out
}

func TestSearchOnlyLatestFullReportPerCluster(t *testing.T) {
	_, c := fake(t, map[string][]Row{
		"reports": {
			report("old-full", "prod", "2026-01-01", nil),
			report("latest-full", "prod", "2026-01-02", Row{"status": "pending"}),
			report("newer-selected", "prod", "2026-01-03", Row{"namespaceScope": selectedScope}),
			report("newest-yaml", "prod", "2026-01-04", Row{"sourceType": "yaml"}),
			report("stage-full", "stage", "2026-01-02", nil),
		},
		"image-usages": {
			searchUsage("old-full", "old", "memelord-old", usageOpts{}),
			searchUsage("latest-full", "prod", "Memelord", usageOpts{}),
			searchUsage("newer-selected", "selected", "memelord-selected", usageOpts{}),
			searchUsage("newest-yaml", "yaml", "memelord-yaml", usageOpts{}),
			searchUsage("stage-full", "stage", "memelord-stage", usageOpts{}),
		},
	})
	r, err := searcher(c, 20, 100).Search(ctx, "MEMELORD", 20, tenancy.UnrestrictedScope)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Matches) != 2 || r.Matches[0].Snapshot.ReportID != "old-full" || r.Matches[1].Snapshot.ReportID != "stage-full" ||
		*r.Matches[0].Cluster != "prod" || r.Matches[0].Snapshot.CreatedAt != "2026-01-01" || *r.Matches[0].Name != "memelord-old" {
		t.Errorf("matches = %+v", r.Matches)
	}
}

func rankOf(u Row, release *string, needle string) (int, bool) {
	raw, _ := json.Marshal(u)
	var usage ImageUsage
	_ = json.Unmarshal(raw, &usage)

	return candidate{usage: usage, release: ParseReleaseInfo(release)}.rankAgainst(needle)
}

func TestSearchRanking(t *testing.T) {
	_, c := fake(t, map[string][]Row{
		"reports": {report("report", "prod", "2026-01-01", nil)},
		"image-usages": {
			searchUsage("report", "substring", "our-api-worker", usageOpts{}),
			searchUsage("report", "prefix", "api-worker", usageOpts{}),
			searchUsage("report", "exact", "API", usageOpts{}),
		},
	})
	r, _ := searcher(c, 20, 100).Search(ctx, "api", 20, tenancy.UnrestrictedScope)
	if !slices.Equal(names(r), []string{"API", "api-worker", "our-api-worker"}) {
		t.Errorf("order = %v", names(r))
	}
	for name, want := range map[string]int{"API": 0, "api-worker": 1, "our-api-worker": 2} {
		if rank, ok := rankOf(searchUsage("r", "g", name, usageOpts{}), nil, "api"); !ok || rank != want {
			t.Errorf("%s rank = %d", name, rank)
		}
	}
}

func TestSearchNamespaceRepositoryAndHelm(t *testing.T) {
	_, c := fake(t, map[string][]Row{
		"reports": {report("report", "prod", "2026-01-01", nil)},
		"image-usages": {
			searchUsage("report", "namespace", "llama-gemma", usageOpts{repository: "ggml-org/llama.cpp", namespace: "llm"}),
			searchUsage("report", "repository", "webui", usageOpts{repository: "open-webui/open-webui"}),
			searchUsage("report", "helm", "controller", usageOpts{repository: "example/controller", release: "release-1"}),
		},
		"release-scores": {release("report", "release-1", map[string]any{"name": "cert-manager", "namespace": "cert-manager", "chartName": "cert-manager-chart"})},
	})
	s := searcher(c, 20, 100)
	for query, want := range map[string]string{"llm": "llama-gemma", "open-webui": "webui", "cert-manager-chart": "controller", "cert-manager": "controller"} {
		r, err := s.Search(ctx, query, 20, tenancy.UnrestrictedScope)
		if err != nil || !slices.Equal(names(r), []string{want}) {
			t.Errorf("%s = %v %v", query, names(r), err)
		}
	}
	if rank, _ := rankOf(searchUsage("r", "g", "llama-gemma", usageOpts{namespace: "llm"}), nil, "llm"); rank != 3 {
		t.Errorf("namespace rank = %d", rank)
	}
	if rank, _ := rankOf(searchUsage("r", "g", "webui", usageOpts{repository: "open-webui/open-webui"}), nil, "open-webui"); rank != 10 {
		t.Errorf("repository rank = %d", rank)
	}
	info := str(`{"name":"cert-manager","namespace":"cert-manager","chartName":"cert-manager-chart"}`)
	for _, q := range []string{"cert-manager-chart", "cert-manager"} {
		if rank, _ := rankOf(searchUsage("r", "g", "controller", usageOpts{}), info, q); rank != 12 {
			t.Errorf("%s helm rank = %d", q, rank)
		}
	}
}

func TestSearchLimitsGroupsNotRows(t *testing.T) {
	b, c := fake(t, map[string][]Row{
		"reports": {report("report", "prod", "2026-01-01", nil)},
		"image-usages": {
			searchUsage("report", "alpha", "api-alpha", usageOpts{repository: "api/alpha"}),
			searchUsage("report", "alpha", "api-alpha", usageOpts{repository: "api/sidecar", container: "sidecar"}),
			searchUsage("report", "beta", "api-beta", usageOpts{repository: "api/beta"}),
		},
	})
	r, _ := searcher(c, 20, 100).Search(ctx, "api", 1, tenancy.UnrestrictedScope)
	if len(r.Matches) != 1 || len(r.Matches[0].Analysis.Images) != 2 ||
		r.Matches[0].Analysis.Images[0].Repository != "api/alpha" || r.Matches[0].Analysis.Images[1].Repository != "api/sidecar" {
		t.Errorf("matches = %+v", r.Matches)
	}
	// One report read serves search and detail loading.
	if n := len(b.RequestsTo("image-usages")); n != 1 {
		t.Errorf("image-usages requests = %d", n)
	}
}

func TestSearchJoinsReleaseAnalysis(t *testing.T) {
	_, c := fake(t, map[string][]Row{
		"reports": {report("report", "prod", "2026-01-01", nil)},
		"image-usages": {
			searchUsage("report", "helm", "helm-api", usageOpts{repository: "api/helm", release: "release-1"}),
			searchUsage("report", "plain", "plain-api", usageOpts{repository: "api/plain"}),
			searchUsage("report", "broken", "broken-api", usageOpts{repository: "api/broken", release: "release-2"}),
		},
		"release-scores": {
			release("report", "release-1", map[string]any{"name": "api-release", "namespace": "apps", "chartName": "api-chart",
				"chartVersion": "1.2.3", "latestChartTag": "1.3.0", "chartAppVersion": "4.5.6"}),
			{"reportId": "report", "groupKey": "release-2", "releaseInfo": "{not-json"},
		},
	})
	r, _ := searcher(c, 20, 100).Search(ctx, "api", 20, tenancy.UnrestrictedScope)
	byName := map[string]WorkloadMatch{}
	for _, m := range r.Matches {
		byName[*m.Name] = m
	}
	want := &HelmAnalysis{ReleaseName: str("api-release"), ReleaseNamespace: str("apps"), ChartName: str("api-chart"),
		ObservedChartVersion: str("1.2.3"), LatestKnownChartVersion: str("1.3.0"), AppVersion: str("4.5.6")}
	if !reflect.DeepEqual(byName["helm-api"].Analysis.Helm, want) {
		t.Errorf("helm = %+v", byName["helm-api"].Analysis.Helm)
	}
	if byName["plain-api"].Analysis.Helm != nil || byName["broken-api"].Analysis.Helm != nil {
		t.Error("helm analysis without valid release info")
	}
}

func TestSearchValidation(t *testing.T) {
	b, c := fake(t, nil)
	s := searcher(c, 20, 100)
	if _, err := s.Search(ctx, "   ", 0, tenancy.UnrestrictedScope); err == nil || err.Error() != "query must be a non-empty string" {
		t.Errorf("empty query err = %v", err)
	}
	if len(b.Requests()) != 0 {
		t.Error("empty query reached the backend")
	}
	// Zero means the default limit in Go; only negative limits are invalid.
	if _, err := s.Search(ctx, "api", -1, tenancy.UnrestrictedScope); err == nil || err.Error() != "limit must be a positive integer" {
		t.Errorf("negative limit err = %v", err)
	}
}

func TestSearchTrimsAndClampsLimit(t *testing.T) {
	var usages []Row
	for _, n := range []string{"api-a", "api-b", "api-c"} {
		usages = append(usages, searchUsage("report", n, n, usageOpts{}))
	}
	_, c := fake(t, map[string][]Row{"reports": {report("report", "prod", "2026-01-01", nil)}, "image-usages": usages})
	s := searcher(c, 1, 2)
	r, _ := s.Search(ctx, " api ", 0, tenancy.UnrestrictedScope)
	if r.Query != "api" || len(r.Matches) != 1 {
		t.Errorf("default = %q %d", r.Query, len(r.Matches))
	}
	if r, _ := s.Search(ctx, "api", 500, tenancy.UnrestrictedScope); len(r.Matches) != 2 {
		t.Errorf("clamped = %d", len(r.Matches))
	}
}

func TestSearchMapsGroupedImages(t *testing.T) {
	// The api image has no deployed tag and appears twice.
	_, c := fake(t, map[string][]Row{
		"reports": {report("report-1", "prod", "2026-07-15T12:00:00.000Z", nil)},
		"image-usages": func() []Row {
			api := searchUsage("report-1", "deployment:apps:api", "api", usageOpts{repository: "example/api", latestTag: "2.0.0", versionStatus: "current"})
			api["deployedTag"] = nil

			return []Row{
				searchUsage("report-1", "deployment:apps:api", "api", usageOpts{repository: "example/sidecar", deployedTag: "1.0.0", latestTag: "1.1.0", versionStatus: "outdated"}),
				api, api,
			}
		}(),
	})
	r, err := searcher(c, 20, 100).Search(ctx, "api", 20, tenancy.UnrestrictedScope)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := json.Marshal(r)
	want := `{"query":"api","matches":[{"workloadId":"deployment:apps:api","name":"api","kind":"Deployment","cluster":"prod","namespace":"apps",` +
		`"analysis":{"status":"outdated","helm":null,"images":[` +
		`{"registry":"registry.example","repository":"example/api","observedTag":null,"latestKnownTag":"2.0.0","status":"analyzed","versionStatus":"current"},` +
		`{"registry":"registry.example","repository":"example/sidecar","observedTag":"1.0.0","latestKnownTag":"1.1.0","status":"analyzed","versionStatus":"outdated"}]},` +
		`"snapshot":{"reportId":"report-1","createdAt":"2026-07-15T12:00:00.000Z"}}],"scope":{"scoped":false,"namespaces":null}}`
	if string(got) != want {
		t.Errorf("result =\n%s\nwant\n%s", got, want)
	}
	if !strings.Contains(string(got), `"helm":null`) {
		t.Error("helm not null")
	}
}
