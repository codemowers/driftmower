package observability

import (
	"context"
	"encoding/json"
	"math"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codemowers/driftmower-mcp/internal/authz"
)

var (
	usageT    = time.Date(2026, 10, 4, 10, 0, 0, 0, time.UTC)
	podLabels = map[string]string{"namespace": "team-a", "pod": "api", "container": "web"}
	podIn     = PodUsageInput{Namespace: "team-a", Pod: "api", WindowSeconds: 300, PerContainer: true}
	hour      = &HistoryInput{HistorySeconds: 3600, StepSeconds: 60}
)

func usageBackend(vector, matrix func() Response) *fakeBackend {
	return &fakeBackend{respond: func(u *url.URL) (Response, error) {
		if strings.HasSuffix(u.Path, "query_range") {
			return matrix(), nil
		}

		return vector(), nil
	}}
}

func matrixOf(series ...map[string]any) Response {
	return jsonBody(map[string]any{"status": "success", "data": map[string]any{"resultType": "matrix", "result": series}})
}

func defaultUsageBackend() *fakeBackend {
	return usageBackend(
		func() Response { return vectorOf(map[string]any{"metric": podLabels, "value": []any{3, "6"}}) },
		func() Response {
			return matrixOf(map[string]any{"metric": podLabels, "values": []any{[]any{1, "2"}, []any{2, "4"}, []any{3, "6"}}})
		},
	)
}

func usageService(b *fakeBackend, j *judge) *Service {
	return &Service{PrometheusURL: "http://prometheus", Backend: b, Judge: j, Now: func() time.Time { return usageT }}
}

func TestSummarizeSamples(t *testing.T) {
	s := SummarizeSamples([]float64{2, 4, 6}, 4, nil)
	if s.Avg != 4 || s.Min != 2 || s.Max != 6 || math.Abs(s.Stddev-math.Sqrt(8.0/3)) > 1e-12 || s.SampleCount != 3 ||
		s.ExpectedSamples != 4 || s.Coverage != 0.75 || s.FirstSampleAt != "" {
		t.Errorf("stats = %+v", s)
	}
	if SummarizeSamples(nil, 61, nil) != nil {
		t.Error("empty samples summarised")
	}
	if s := SummarizeSamples([]float64{0, 0}, 2, nil); s.Stddev != 0 {
		t.Errorf("stddev = %v", s.Stddev)
	}
}

func TestSourceMetrics(t *testing.T) {
	got := sourceMetrics(`max by (instance,node) (node_uname_info{node!=""}) and on (node) max by (node) (kube_node_info) * rate(node_cpu_seconds_total[5m]) node_cpu_seconds_total `)
	if !slices.Equal(got, []string{"node_uname_info", "kube_node_info", "node_cpu_seconds_total"}) {
		t.Errorf("sourceMetrics = %v", got)
	}
}

func TestSnapshotHasNoHistory(t *testing.T) {
	b := defaultUsageBackend()
	res, err := usageService(b, &judge{}).PodUsage(context.Background(), alice, podIn, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.History != nil || res.Metrics["cpuUsed"].Statistics != nil || res.Metrics["cpuThrottledTime"] != nil {
		t.Errorf("snapshot = %+v", res)
	}
	for _, u := range b.urls {
		if u.Path != "/api/v1/query" || strings.Contains(u.RawQuery, "container_cpu_cfs_throttled_seconds_total") {
			t.Errorf("unexpected query %s", u)
		}
	}
}

func TestHistoryKeepsDeletedPodSamples(t *testing.T) {
	b := usageBackend(
		func() Response { return vectorOf() },
		func() Response {
			return matrixOf(map[string]any{"metric": podLabels, "values": []any{[]any{1791104520, "2"}, []any{1791104580, "4"}}})
		},
	)
	res, err := usageService(b, &judge{}).PodUsage(context.Background(), alice, podIn, hour)
	if err != nil {
		t.Fatal(err)
	}
	cpu := res.Metrics["cpuUsed"]
	if cpu.Total != nil || cpu.Statistics == nil || cpu.Statistics.Avg != 3 || cpu.Statistics.SampleCount != 2 ||
		cpu.Statistics.FirstSampleAt != time.Unix(1791104520, 0).UTC().Format("2006-01-02T15:04:05.000Z") ||
		cpu.Statistics.LastSampleAt != time.Unix(1791104580, 0).UTC().Format("2006-01-02T15:04:05.000Z") {
		t.Errorf("cpuUsed = %+v %+v", cpu, cpu.Statistics)
	}
	if len(cpu.HistoryBreakdown) == 0 || cpu.HistoryBreakdown[0].Labels["container"] != "web" {
		t.Errorf("history breakdown = %+v", cpu.HistoryBreakdown)
	}
	if res.History == nil || res.History.FirstSampleAt == nil {
		t.Errorf("history = %+v", res.History)
	}
}

func TestPodHistoryScopedWithStatistics(t *testing.T) {
	b := defaultUsageBackend()
	j := &judge{}
	res, err := usageService(b, j).PodUsage(context.Background(), alice, podIn, hour)
	if err != nil {
		t.Fatal(err)
	}
	if len(j.asked) != 1 || j.asked[0] != (authz.Attributes{Namespace: "team-a", Resource: "pods", Verb: "list"}) {
		t.Errorf("asked = %+v", j.asked)
	}
	h := res.History
	if h.Seconds != 3600 || h.StepSeconds != 60 || h.Stddev != "population" || h.RequestedStart != "2026-10-04T09:00:00.000Z" ||
		h.RequestedEnd != "2026-10-04T10:00:00.000Z" || *h.FirstSampleAt != "1970-01-01T00:00:01.000Z" || *h.LastSampleAt != "1970-01-01T00:00:03.000Z" {
		t.Errorf("history = %+v", h)
	}
	cpu := res.Metrics["cpuUsed"]
	if *cpu.Total != 6 || cpu.Unit != "cores" || cpu.Statistics.Avg != 4 || cpu.Statistics.Min != 2 || cpu.Statistics.Max != 6 ||
		cpu.Statistics.SampleCount != 3 || cpu.Statistics.ExpectedSamples != 61 {
		t.Errorf("cpuUsed = %+v %+v", cpu, cpu.Statistics)
	}
	if cpu.Breakdown[0].Statistics == nil || cpu.Breakdown[0].Statistics.Avg != 4 {
		t.Errorf("breakdown statistics = %+v", cpu.Breakdown)
	}
	thr := res.Metrics["cpuThrottling"]
	if thr.Total == nil || *thr.Total != 1 || thr.Statistics == nil || thr.Statistics.Avg != 1 || thr.Statistics.Stddev != 0 {
		t.Errorf("cpuThrottling = %+v %+v", thr, thr.Statistics)
	}
	for _, u := range b.urls {
		q := u.Query()
		if !strings.Contains(q.Get("query"), `namespace="team-a",pod="api"`) {
			t.Errorf("unscoped query %s", q.Get("query"))
		}
		if strings.HasSuffix(u.Path, "query_range") {
			start, _ := strconv.ParseFloat(q.Get("start"), 64)
			end, _ := strconv.ParseFloat(q.Get("end"), 64)
			if end-start != 3600 || q.Get("step") != "60" {
				t.Errorf("range %s", u)
			}
		} else if q.Get("time") != "2026-10-04T10:00:00.000Z" {
			t.Errorf("time = %s", q.Get("time"))
		}
	}
}

func TestUsageFailsClosed(t *testing.T) {
	b := defaultUsageBackend()
	svc := usageService(b, &judge{answer: deny})
	if _, err := svc.PodUsage(context.Background(), alice, podIn, nil); err == nil {
		t.Error("pod usage allowed")
	}
	if _, err := svc.ClusterUsage(context.Background(), alice, ClusterUsageInput{WindowSeconds: 300}, nil); err == nil {
		t.Error("cluster usage allowed")
	}
	if b.calls() != 0 {
		t.Error("queried after denial")
	}
}

func TestClusterHistoryRequiresPodsAndNodes(t *testing.T) {
	b := defaultUsageBackend()
	j := &judge{}
	res, err := usageService(b, j).ClusterUsage(context.Background(), alice, ClusterUsageInput{WindowSeconds: 300},
		&HistoryInput{HistorySeconds: 7200, StepSeconds: 120})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(j.asked, []authz.Attributes{{Resource: "pods", Verb: "list"}, {Resource: "nodes", Verb: "list"}}) {
		t.Errorf("asked = %+v", j.asked)
	}
	m := res.Metrics
	if !strings.Contains(m["cpuUsed"].Query, "kube_node_info") || !strings.Contains(m["cpuUsed"].Query, "group_left (node)") {
		t.Errorf("cpuUsed query = %s", m["cpuUsed"].Query)
	}
	for _, want := range []string{"node_cpu_seconds_total", "node_uname_info", "kube_node_info"} {
		if !slices.Contains(m["cpuUsed"].SourceMetrics, want) {
			t.Errorf("cpuUsed sourceMetrics %v lack %s", m["cpuUsed"].SourceMetrics, want)
		}
	}
	if !strings.Contains(m["rootFilesystemCapacity"].Query, `mountpoint="/"`) ||
		!slices.Contains(m["rootFilesystemCapacity"].SourceMetrics, "node_filesystem_size_bytes") ||
		!slices.Contains(m["lvmVolumeGroupSize"].SourceMetrics, "topolvm_volumegroup_size_bytes") ||
		!slices.Contains(m["lvmVolumeGroupAvailable"].SourceMetrics, "topolvm_volumegroup_available_bytes") {
		t.Error("cluster query provenance incomplete")
	}
	if m["filesystemUsage"] != nil || m["cpuUsed"].Breakdown != nil {
		t.Error("pod metric or breakdown in cluster summary")
	}
	for _, u := range b.urls {
		if strings.HasSuffix(u.Path, "query_range") && u.Query().Get("step") != "120" {
			t.Errorf("step = %s", u.Query().Get("step"))
		}
	}
}

func TestClusterNodeDeniedAfterPods(t *testing.T) {
	b := defaultUsageBackend()
	j := &judge{answer: func(_ authz.Identity, a authz.Attributes) authz.Verdict {
		if a.Resource == "nodes" {
			return authz.No
		}

		return authz.Yes
	}}
	if _, err := usageService(b, j).ClusterUsage(context.Background(), alice, ClusterUsageInput{WindowSeconds: 300}, nil); err == nil ||
		!strings.Contains(err.Error(), "list nodes") {
		t.Errorf("err = %v", err)
	}
	if b.calls() != 0 {
		t.Error("queried")
	}
}

func TestClusterPartialNodeCoverage(t *testing.T) {
	b := &fakeBackend{respond: func(u *url.URL) (Response, error) {
		q := u.Query().Get("query")
		node := func(n, v string) map[string]any {
			return map[string]any{"metric": map[string]string{"node": n}, "value": []any{1, v}}
		}
		if strings.HasPrefix(q, "max by (node) (kube_node_status_capacity") {
			return vectorOf(node("a", "4"), node("b", "4")), nil
		}

		return vectorOf(node("a", "1")), nil
	}}
	res, err := usageService(b, &judge{}).ClusterUsage(context.Background(), alice, ClusterUsageInput{WindowSeconds: 300, PerNode: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(res.Metrics["cpuUsed"].Warnings, "Partial node coverage; missing: b") {
		t.Errorf("cpuUsed warnings = %v", res.Metrics["cpuUsed"].Warnings)
	}
	if slices.ContainsFunc(res.Metrics["cpuRequests"].Warnings, func(w string) bool { return strings.HasPrefix(w, "Partial") }) {
		t.Error("requests flagged for node coverage")
	}
	if u := res.Metrics["cpuUtilization"]; u.Total == nil || *u.Total != 0.125 || len(u.Breakdown) != 1 || u.Breakdown[0].Value != 0.25 {
		t.Errorf("cpuUtilization = %+v", u)
	}
	if res.Metrics["cpuUsed"].Breakdown == nil {
		t.Error("perNode breakdown dropped")
	}
}

func TestUsageErrorsStayExplicit(t *testing.T) {
	b := usageBackend(func() Response { return vectorOf() }, func() Response { return matrixOf() })
	svc := usageService(b, &judge{})
	res, _ := svc.PodUsage(context.Background(), alice, podIn, nil)
	if res.Metrics["cpuUsed"].Total != nil || !slices.Contains(res.Metrics["cpuUsed"].Warnings, "No samples available") {
		t.Errorf("empty = %+v", res.Metrics["cpuUsed"])
	}

	b.respond = func(*url.URL) (Response, error) { return Response{Status: 503, Body: []byte("unavailable")}, nil }
	res, _ = svc.PodUsage(context.Background(), alice, podIn, nil)
	if res.Metrics["cpuUsed"].Total != nil || res.Metrics["cpuUsed"].Error != "Prometheus returned HTTP 503" {
		t.Errorf("503 = %+v", res.Metrics["cpuUsed"])
	}

	b.respond = func(*url.URL) (Response, error) {
		return vectorOf(map[string]any{"metric": podLabels, "value": []any{1, "NaN"}}), nil
	}
	res, _ = svc.PodUsage(context.Background(), alice, podIn, nil)
	if !strings.Contains(res.Metrics["cpuUsed"].Error, "non-finite") {
		t.Errorf("NaN = %+v", res.Metrics["cpuUsed"])
	}
}

func TestHistoryOutsidePodDiscarded(t *testing.T) {
	b := usageBackend(
		func() Response { return vectorOf(map[string]any{"metric": podLabels, "value": []any{1, "6"}}) },
		func() Response {
			return matrixOf(map[string]any{"metric": map[string]string{"namespace": "other", "pod": "private"}, "values": []any{[]any{1, "4"}}})
		},
	)
	res, err := usageService(b, &judge{}).PodUsage(context.Background(), alice, podIn, hour)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.Metrics["cpuUsed"].StatisticsError, "outside the requested pod") {
		t.Errorf("statisticsError = %q", res.Metrics["cpuUsed"].StatisticsError)
	}
	if raw, _ := json.Marshal(res); strings.Contains(string(raw), "private") {
		t.Error("foreign series leaked")
	}
}

func TestAlignedEvaluationTime(t *testing.T) {
	var mu sync.Mutex
	times := map[string]bool{}
	for _, offset := range []time.Duration{time.Second, 9 * time.Second} {
		b := defaultUsageBackend()
		inner := b.respond
		b.respond = func(u *url.URL) (Response, error) {
			mu.Lock()
			times[u.Query().Get("time")] = true
			mu.Unlock()

			return inner(u)
		}
		svc := usageService(b, &judge{})
		svc.Alignment = 15 * time.Second
		svc.Now = func() time.Time { return usageT.Add(offset) }
		if _, err := svc.PodUsage(context.Background(), alice, podIn, nil); err != nil {
			t.Fatal(err)
		}
	}
	if len(times) != 1 || !times["2026-10-04T10:00:00.000Z"] {
		t.Errorf("times = %v", times)
	}
}

func TestUsageChargesEveryQuery(t *testing.T) {
	b := defaultUsageBackend()
	svc := usageService(b, &judge{})
	svc.Budget = &Budget{QueriesPerMinute: 1000, MaxConcurrentCalls: 1}
	if _, err := svc.PodUsage(context.Background(), alice, podIn, nil); err != nil {
		t.Fatal(err)
	}
	svc.Budget.mu.Lock()
	tokens := svc.Budget.callers[alice.User].Value.(*callerState).tokens
	svc.Budget.mu.Unlock()
	if charged := 1000 - math.Round(tokens); int(charged) != b.calls() || b.calls() <= 5 {
		t.Errorf("charged %v for %d queries", charged, b.calls())
	}
}
