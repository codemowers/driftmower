package observability

import (
	"context"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestWorkloadUsageSumsPodsAndDedupesClaims(t *testing.T) {
	// Labels as Prometheus returns them for the query's grouping: a sum
	// keeps only its by() labels.
	pod := func(name, value string) map[string]any {
		return map[string]any{"metric": map[string]string{"namespace": "team", "pod": name}, "value": []any{1, value}}
	}
	b := &fakeBackend{respond: func(u *url.URL) (Response, error) {
		q := u.Query().Get("query")
		if strings.HasPrefix(q, "sum by (") && !strings.HasPrefix(q, "sum by (namespace,pod)") {
			t.Errorf("query drops the namespace label: %s", q)
		}
		switch {
		case strings.Contains(q, "working_set"):
			return vectorOf(pod("api-1", "100"), pod("api-2", "50"), pod("other", "999")), nil
		case strings.Contains(q, `resource_limits`) && strings.Contains(q, `"memory"`):
			return vectorOf(pod("api-1", "200"), pod("api-2", "200"), pod("migrate", "500")), nil
		case strings.Contains(q, "kube_pod_status_phase"):
			return vectorOf(pod("migrate", "1")), nil
		case strings.Contains(q, "qos_class"):
			return vectorOf(
				map[string]any{"metric": map[string]string{"namespace": "team", "pod": "api-1", "qos_class": "Burstable"}, "value": []any{1, "1"}},
				map[string]any{"metric": map[string]string{"namespace": "team", "pod": "api-2", "qos_class": "Burstable"}, "value": []any{1, "1"}},
			), nil
		case strings.Contains(q, "volume_stats_used"):
			return vectorOf(map[string]any{"metric": map[string]string{"persistentvolumeclaim": "data"}, "value": []any{1, "10"}}), nil
		case strings.Contains(q, "volume_stats_capacity"):
			return vectorOf(map[string]any{"metric": map[string]string{"persistentvolumeclaim": "data"}, "value": []any{1, "40"}}), nil
		}

		return vectorOf(), nil
	}}
	svc := &Service{PrometheusURL: "http://prometheus", Backend: b, Judge: &judge{}, Now: func() time.Time { return usageT }}
	r, err := svc.WorkloadUsage(context.Background(), alice, "team", []string{"api-1", "api-2", "migrate"})
	if err != nil {
		t.Fatal(err)
	}
	if *r.Memory.Usage != 150 || *r.Memory.Limit != 400 || r.Memory.Request != nil || r.CPU.Usage != nil {
		t.Fatalf("memory %+v cpu %+v", r.Memory, r.CPU)
	}
	if r.ReplicaCount != 2 || r.QOSClass == nil || *r.QOSClass != "Burstable" || len(r.Volumes) != 1 || r.Volumes[0].Capacity != 40 {
		t.Fatalf("result %+v", r)
	}
	if !strings.Contains(b.urls[0].Query().Get("query"), `pod=~"api-1|api-2|migrate"`) {
		t.Fatalf("query %s", b.urls[0].Query().Get("query"))
	}
}

func TestWorkloadUsageRequiresListPods(t *testing.T) {
	svc := &Service{PrometheusURL: "http://prometheus", Backend: &fakeBackend{}, Judge: &judge{answer: deny}, Now: func() time.Time { return usageT }}
	if _, err := svc.WorkloadUsage(context.Background(), alice, "team", []string{"api-1"}); err == nil {
		t.Fatal("usage read without list pods")
	}
}
