package observability

import (
	"context"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
	"net/url"
	"strings"
	"testing"
)

func TestClusterHealthIncludesPerNodeMemoryAndPreservesMissingData(t *testing.T) {
	backend := &fakeBackend{respond: func(u *url.URL) (Response, error) {
		q := u.Query().Get("query")
		if strings.Contains(q, "node_boot_time_seconds") {
			if !strings.Contains(q, "node_uname_info") || !strings.Contains(q, "kube_node_info") {
				t.Errorf("boot time query lacks node identity/inventory: %s", q)
			}
			return vectorOf(map[string]any{"metric": map[string]string{"node": "node-a"}, "value": []any{1, "1700000000"}}), nil
		}
		if strings.Contains(q, `kube_node_status_capacity{resource="memory"`) {
			return vectorOf(map[string]any{"metric": map[string]string{"node": "node-a"}, "value": []any{1, "1000"}}, map[string]any{"metric": map[string]string{"node": "node-b"}, "value": []any{1, "2000"}}), nil
		}
		if strings.Contains(q, "node_memory_MemTotal_bytes") && strings.Contains(q, "node_memory_MemAvailable_bytes") {
			return vectorOf(map[string]any{"metric": map[string]string{"node": "node-a"}, "value": []any{1, "400"}}), nil
		}
		return vectorOf(), nil
	}}
	s := usageService(backend, &judge{})
	s.PrometheusExternalURL = "https://prometheus.example"
	s.Kubernetes = fake.NewClientset(&corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "node-a"}}, &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "node-b"}})
	result, err := s.ClusterHealth(context.Background(), alice)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Nodes) != 2 {
		t.Fatalf("nodes %+v", result.Nodes)
	}
	if boot := result.Nodes[0].BootTimeSeconds; boot == nil || *boot != 1700000000 {
		t.Fatalf("node boot time %+v", boot)
	}
	if result.Nodes[1].BootTimeSeconds != nil {
		t.Fatalf("missing boot time became a false zero: %+v", result.Nodes[1].BootTimeSeconds)
	}
	memory := result.Nodes[0].Memory
	if memory == nil || memory.Used != 400 || memory.Total != 1000 || len(memory.Graph) != 2 || !strings.Contains(memory.Graph[0], `node="node-a"`) {
		t.Fatalf("node memory %+v", memory)
	}
	if result.Nodes[1].Memory != nil {
		t.Fatalf("missing usage became a false zero: %+v", result.Nodes[1].Memory)
	}
}
