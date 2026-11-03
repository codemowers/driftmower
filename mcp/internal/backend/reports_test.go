package backend

import (
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func TestLatestReportsPerCluster(t *testing.T) {
	_, c := fake(t, map[string][]Row{"reports": {
		report("prod-old", "prod", "2026-01-01", nil),
		report("prod-ready", "prod", "2026-01-02", nil),
		report("prod-in-progress", "prod", "2026-01-03", Row{"status": "in_progress"}),
		report("prod-scoped", "prod", "2026-01-04", Row{"namespaceScope": selectedScope}),
		report("prod-yaml", "prod", "2026-01-05", Row{"sourceType": "yaml"}),
		report("staging-ready", "staging", "2026-01-01", nil),
	}})
	got, err := c.LatestReports(ctx, "")
	want := []ReportSnapshot{{"prod-ready", "prod", "2026-01-02"}, {"staging-ready", "staging", "2026-01-01"}}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Errorf("reports = %+v %v", got, err)
	}
}

func TestLatestReportsQueriesServerSide(t *testing.T) {
	b, c := fake(t, map[string][]Row{"reports": {report("prod-ready", "prod", "2026-01-02", nil)}})
	if _, err := c.LatestReports(ctx, "prod"); err != nil {
		t.Fatal(err)
	}
	reqs := b.Requests()
	if len(reqs) != 1 {
		t.Fatalf("requests = %v", reqs)
	}
	for _, want := range []string{"sourceType=cluster", "status=ready", "clusterContext=prod", `namespaceScope={"mode":"all"}`,
		"$select[0]=id", "$sort[createdAt]=-1&$sort[id]=-1", "$limit=1"} {
		if !strings.Contains(reqs[0], want) {
			t.Errorf("request %q lacks %q", reqs[0], want)
		}
	}
}

func TestScopedReportsDoNotCrowdOutFullReport(t *testing.T) {
	rows := []Row{}
	for i := range 600 {
		rows = append(rows, report(fmt.Sprintf("scoped-%04d", i), "prod", fmt.Sprintf("2026-02-%02d", 1+i%28), Row{"namespaceScope": selectedScope}))
	}
	rows = append(rows, report("prod-full", "prod", "2026-01-01", nil))
	_, c := fake(t, map[string][]Row{"reports": rows})
	got, err := c.LatestReports(ctx, "")
	if err != nil || !reflect.DeepEqual(got, []ReportSnapshot{{"prod-full", "prod", "2026-01-01"}}) {
		t.Errorf("reports = %+v %v", got, err)
	}
}

func TestLatestReportsExactClusterAndTieBreak(t *testing.T) {
	_, c := fake(t, map[string][]Row{"reports": {
		report("prod-ready", "prod", "2026-01-02", nil),
		report("staging-ready", "staging", "2026-01-03", nil),
	}})
	got, _ := c.LatestReports(ctx, "staging")
	if !reflect.DeepEqual(got, []ReportSnapshot{{"staging-ready", "staging", "2026-01-03"}}) {
		t.Errorf("staging = %+v", got)
	}

	_, c = fake(t, map[string][]Row{"reports": {
		report("report-a", "prod", "2026-01-02", nil),
		report("report-b", "prod", "2026-01-02", nil),
	}})
	got, _ = c.LatestReports(ctx, "")
	if len(got) != 1 || got[0].ReportID != "report-b" {
		t.Errorf("tie break = %+v", got)
	}
}

func TestNoReadyReport(t *testing.T) {
	_, c := fake(t, map[string][]Row{"reports": {report("prod-pending", "prod", "2026-01-02", Row{"status": "pending"})}})
	got, err := c.LatestReports(ctx, "")
	if err != nil || len(got) != 0 {
		t.Errorf("reports = %+v %v", got, err)
	}
	if r, err := c.LatestInClusterReport(ctx); r != nil || err != nil {
		t.Errorf("in-cluster = %+v %v", r, err)
	}
}

func TestInClusterReports(t *testing.T) {
	_, c := fake(t, map[string][]Row{"reports": {
		report("in-cluster-old", "in-cluster", "2026-01-01", nil),
		report("in-cluster-new", "in-cluster", "2026-01-02", nil),
		report("remote", "prod", "2026-01-03", nil),
	}})
	r, err := c.LatestInClusterReport(ctx)
	if err != nil || r == nil || *r != (ReportSnapshot{"in-cluster-new", "in-cluster", "2026-01-02"}) {
		t.Errorf("latest = %+v %v", r, err)
	}

	_, c = fake(t, map[string][]Row{"reports": {
		report("pinned", "in-cluster", "2026-01-01", nil),
		report("newer", "in-cluster", "2026-01-02", nil),
		report("scoped", "in-cluster", "2026-01-03", Row{"namespaceScope": selectedScope}),
		report("remote", "prod", "2026-01-04", nil),
	}})
	if r, _ := c.InClusterReport(ctx, "pinned"); r == nil || r.ReportID != "pinned" {
		t.Errorf("pinned = %+v", r)
	}
	// A namespace-scoped or remote report is not the snapshot a cursor pinned.
	for _, id := range []string{"scoped", "remote", "missing"} {
		if r, err := c.InClusterReport(ctx, id); r != nil || err != nil {
			t.Errorf("%s = %+v %v", id, r, err)
		}
	}
}

func usageRow(reportID string) Row {
	return Row{"reportId": reportID, "workloadGroupKey": "deployment:apps:api", "workloadKind": "Deployment", "workloadNamespace": "apps",
		"workloadName": "api", "releaseGroupKey": nil, "containerName": "main", "registry": "registry.example", "repository": "example/api",
		"deployedTag": "1.0.0", "latestTag": "2.0.0", "status": "outdated", "versionStatus": "behind"}
}

func TestRowLoaderProjectsAndOrders(t *testing.T) {
	b, c := fake(t, map[string][]Row{"image-usages": {usageRow("report-1")}})
	if _, err := (&RowLoader{Client: c}).Load(ctx, "report-1"); err != nil {
		t.Fatal(err)
	}
	usages, scores := b.RequestsTo("image-usages"), b.RequestsTo("release-scores")
	// Selecting keeps the payload column off the wire; a paged read needs a
	// stable order or a boundary can skip a row.
	if !strings.Contains(usages[0], "$select[0]=id") || strings.Contains(usages[0], "payload") || !strings.Contains(usages[0], "$sort[id]=1") {
		t.Errorf("usages request = %s", usages[0])
	}
	if !strings.Contains(scores[0], "$sort[groupKey]=1") {
		t.Errorf("scores request = %s", scores[0])
	}
}

func TestRowLoaderSharesConcurrentLoads(t *testing.T) {
	b, c := fake(t, map[string][]Row{"image-usages": {usageRow("report-1")}})
	l := &RowLoader{Client: c}
	var wg sync.WaitGroup
	results := make([]*ReportRows, 2)
	for i := range results {
		wg.Go(func() { results[i], _ = l.Load(ctx, "report-1") })
	}
	wg.Wait()
	if results[0] == nil || results[0] != results[1] || len(b.RequestsTo("image-usages")) != 1 {
		t.Errorf("results %p %p, requests %d", results[0], results[1], len(b.RequestsTo("image-usages")))
	}
}

func TestRowLoaderCacheAndEviction(t *testing.T) {
	var ids []string
	var rows []Row
	for i := range 17 {
		ids = append(ids, fmt.Sprintf("report-%02d", i))
		rows = append(rows, usageRow(ids[i]))
	}
	b, c := fake(t, map[string][]Row{"image-usages": rows})
	l := &RowLoader{Client: c}

	// A working set of six clusters stays resident.
	for range 2 {
		for _, id := range ids[:6] {
			_, _ = l.Load(ctx, id)
		}
	}
	if n := len(b.RequestsTo("image-usages")); n != 6 {
		t.Errorf("requests = %d", n)
	}

	for _, id := range ids[:16] {
		_, _ = l.Load(ctx, id)
	}
	// Touch the oldest so it is no longer the eviction candidate.
	_, _ = l.Load(ctx, "report-00")
	_, _ = l.Load(ctx, "report-16")
	before := len(b.RequestsTo("image-usages"))
	_, _ = l.Load(ctx, "report-00")
	if n := len(b.RequestsTo("image-usages")); n != before {
		t.Errorf("report-00 reloaded")
	}
	_, _ = l.Load(ctx, "report-01")
	if n := len(b.RequestsTo("image-usages")); n != before+1 {
		t.Errorf("report-01 not evicted")
	}
}

func TestRowLoaderDoesNotCacheFailures(t *testing.T) {
	_, c := fake(t, map[string][]Row{"image-usages": {usageRow("report-1")}})
	token := c.Token
	c.Token = "wrong"
	l := &RowLoader{Client: c}
	if _, err := l.Load(ctx, "report-1"); err == nil {
		t.Fatal("load with a bad token succeeded")
	}
	c.Token = token
	if r, err := l.Load(ctx, "report-1"); err != nil || len(r.ImageUsages) != 1 {
		t.Errorf("retry = %+v %v", r, err)
	}
}

func TestReleaseInfo(t *testing.T) {
	if ParseReleaseInfo(nil) != nil || ParseReleaseInfo(str("{not-json")) != nil {
		t.Error("malformed release info parsed")
	}
	info := ParseReleaseInfo(str(`{"name":"api","chartVersion":"1.2.3"}`))
	if info == nil || *info.Name != "api" || *info.ChartVersion != "1.2.3" {
		t.Errorf("info = %+v", info)
	}
	if got := releaseInfoText([]byte(`{"a":1}`)); got == nil || *got != `{"a":1}` {
		t.Errorf("object text = %v", got)
	}
	if got := releaseInfoText([]byte(`"{\"a\":1}"`)); got == nil || *got != `{"a":1}` {
		t.Errorf("string text = %v", got)
	}
}
