package observability

import (
	"context"
	"net/url"
	"strings"
	"testing"
)

func TestClusterIOAggregatesInPrometheusAndPreservesMissingRates(t *testing.T) {
	b := &fakeBackend{respond: func(u *url.URL) (Response, error) {
		q := u.Query().Get("query")
		if strings.Contains(q, "node_network_receive_bytes_total") || strings.Contains(q, "node_disk_read_bytes_total") {
			if !strings.HasPrefix(q, "sum by (node)") || !strings.Contains(q, "kube_node_info") {
				t.Errorf("unaggregated or unscoped I/O query: %s", q)
			}
			if strings.Contains(q, "node_disk_read_bytes_total") && !strings.Contains(q, `device=~"sd[a-z]+|vd[a-z]+`) {
				t.Errorf("disk selector missing: %s", q)
			}
			return vectorOf(map[string]any{"metric": map[string]string{"node": "node-a"}, "value": []any{1, "128"}}, map[string]any{"metric": map[string]string{"node": "node-b"}, "value": []any{1, "0"}}), nil
		}
		return vectorOf(), nil
	}}
	u, err := usageService(b, &judge{}).ClusterUsage(context.Background(), alice, ClusterUsageInput{WindowSeconds: 300, PerNode: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	r := clusterResources(u)
	if r.IO.NetworkRx == nil || *r.IO.NetworkRx != 128 || r.IO.DiskRead == nil || *r.IO.DiskRead != 128 || r.IO.NetworkTx != nil || r.IO.DiskWrite != nil {
		t.Fatalf("totals %+v", r.IO)
	}
	if len(r.IO.Nodes) != 2 || r.IO.Nodes[0].Node != "node-a" || *r.IO.Nodes[1].DiskRead != 0 || r.IO.Nodes[1].DiskWrite != nil {
		t.Fatalf("nodes %+v", r.IO.Nodes)
	}
	if len(r.Graphs["network"]) != 2 || len(r.Graphs["disk"]) != 2 {
		t.Fatal(r.Graphs)
	}
}
