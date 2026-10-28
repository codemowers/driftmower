package mcpserver

import (
	"context"
	"log/slog"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/codemowers/driftmower-mcp/internal/auth"
	"github.com/codemowers/driftmower-mcp/internal/cluster"
	"github.com/codemowers/driftmower-mcp/internal/observability"
)

// fakeBackend answers every Prometheus instant query with one sample, every
// range query with three, and Loki with one stream, all in team-a/api.
func fakeBackend(t *testing.T) (observability.Requester, *[]string) {
	var mu sync.Mutex
	var queries []string
	labels := `{"namespace":"team-a","pod":"api","container":"app","node":"n1","persistentvolumeclaim":"data"}`

	return observability.RequesterFunc(func(_ context.Context, u *url.URL) (observability.Response, error) {
		mu.Lock()
		queries = append(queries, u.Path+"?"+u.RawQuery)
		mu.Unlock()
		switch {
		case strings.HasSuffix(u.Path, "/loki/api/v1/query_range"):
			return observability.Response{Status: 200, Body: []byte(`{"status":"success","data":{"resultType":"streams","result":[
				{"stream":{"namespace":"team-a","pod":"api"},"values":[["1761652800000000000","boom"]]}]}}`)}, nil
		case strings.HasSuffix(u.Path, "/query_range"):
			return observability.Response{Status: 200, Body: []byte(`{"status":"success","data":{"resultType":"matrix","result":[
				{"metric":` + labels + `,"values":[[1761649200,"1"],[1761649260,"2"],[1761649320,"3"]]}]}}`)}, nil
		default:
			return observability.Response{Status: 200, Body: []byte(`{"status":"success","data":{"resultType":"vector","result":[
				{"metric":` + labels + `,"value":[1761652800,"2"]}]}}`)}, nil
		}
	}), &queries
}

func TestObservabilityTools(t *testing.T) {
	backend, queries := fakeBackend(t)
	k := fake.NewClientset(&corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Namespace: "team-a", Name: "data"},
		Spec: corev1.PersistentVolumeClaimSpec{Resources: corev1.VolumeResourceRequirements{
			Requests: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse("1Gi")}}},
	})
	o := &observability.Service{
		PrometheusURL: "http://prometheus:9090", LokiURL: "http://loki:3100", LogsEnabled: true,
		Backend: backend, Kubernetes: k, Judge: allowAll{},
		Budget: &observability.Budget{QueriesPerMinute: 1000, MaxConcurrentCalls: 2},
		Now:    func() time.Time { return time.Date(2025, 10, 28, 12, 0, 7, 0, time.UTC) }, Alignment: 15 * time.Second,
	}
	id := "bravo.example.com"
	s := connectTo(t, New(Deps{
		Cluster: cluster.NewIdentity(&id, nil, ""), Version: "test", Logger: slog.New(slog.DiscardHandler),
		Mapping: auth.Mapping{UsernameClaim: "sub"}, Observability: o,
	}))

	_, out := call(t, s, "get_pod_resource_usage", map[string]any{"namespace": "team-a", "pod": "api"})
	cpu := out["metrics"].(map[string]any)["cpuUsed"].(map[string]any)
	if out["observedAt"] != "2025-10-28T12:00:00.000Z" || out["windowSeconds"].(float64) != 300 || cpu["total"].(float64) != 2 ||
		cpu["breakdown"] == nil || cpu["sourceMetrics"].([]any)[0] != "container_cpu_usage_seconds_total" {
		t.Errorf("pod usage = %v", out)
	}
	throttling := out["metrics"].(map[string]any)["cpuThrottling"].(map[string]any)
	if throttling["total"].(float64) != 1 {
		t.Errorf("throttling = %v", throttling)
	}

	_, out = call(t, s, "get_pod_resource_usage_history", map[string]any{"namespace": "team-a", "pod": "api"})
	stats := out["metrics"].(map[string]any)["memoryUsage"].(map[string]any)["statistics"].(map[string]any)
	if stats["avg"].(float64) != 2 || stats["sampleCount"].(float64) != 3 || stats["expectedSamples"].(float64) != 61 ||
		out["history"].(map[string]any)["stddev"] != "population" {
		t.Errorf("history = %v", out)
	}

	_, out = call(t, s, "get_cluster_resource_usage", map[string]any{})
	if _, ok := out["metrics"].(map[string]any)["cpuUsed"].(map[string]any)["breakdown"]; ok {
		t.Error("breakdown returned without perNode")
	}

	_, out = call(t, s, "query_metrics", map[string]any{"namespace": "team-a", "metric": "http_requests_total",
		"labels": map[string]any{"code": "500"}, "operation": "rate", "aggregate": "sum", "groupBy": []string{"pod"}})
	if out["query"] != `sum by (namespace,pod) (rate(http_requests_total{namespace="team-a",code="500"}[300s]))` {
		t.Errorf("query = %v", out["query"])
	}

	_, out = call(t, s, "query_logs", map[string]any{"namespace": "team-a", "pod": "api", "contains": "boom"})
	if out["source"] != "loki" || out["query"] != `{namespace="team-a",pod="api"} |= "boom"` {
		t.Errorf("logs = %v", out)
	}

	_, out = call(t, s, "list_volumes", map[string]any{"namespace": "team-a"})
	claim := out["claims"].([]any)[0].(map[string]any)
	if claim["requestedStorage"] != "1Gi" || claim["usage"].(map[string]any)["usedBytes"].(float64) != 2 {
		t.Errorf("volumes = %v", out)
	}

	bad, err := s.CallTool(context.Background(), &mcp.CallToolParams{Name: "query_metrics", Arguments: map[string]any{
		"namespace": "team-a", "metric": "up", "labels": map[string]any{"namespace": "other"}}})
	if err != nil || !bad.IsError {
		t.Errorf("namespace label filter accepted: %+v %v", bad, err)
	}
	for _, q := range *queries {
		if strings.Contains(q, "/api/v1/query?") && !strings.Contains(q, "time=") && !strings.Contains(q, "http_requests_total") {
			t.Errorf("instant query without aligned time: %s", q)
		}
	}
}
