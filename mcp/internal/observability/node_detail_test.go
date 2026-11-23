package observability

import (
	"context"
	"net/url"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/codemowers/driftmower/mcp/internal/authz"
)

func TestVolumeOnHost(t *testing.T) {
	node := &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "node-a", Labels: map[string]string{corev1.LabelHostname: "host-a", "topology.topolvm.io/node": "node-a", "topology.kubernetes.io/zone": "zone-a"}}}
	in := func(key, value string) corev1.NodeSelectorRequirement {
		return corev1.NodeSelectorRequirement{Key: key, Operator: corev1.NodeSelectorOpIn, Values: []string{value}}
	}
	term := func(expressions ...corev1.NodeSelectorRequirement) corev1.NodeSelectorTerm {
		return corev1.NodeSelectorTerm{MatchExpressions: expressions}
	}
	for _, tc := range []struct {
		name  string
		terms []corev1.NodeSelectorTerm
		want  bool
	}{
		{"no terms", nil, false},
		{"empty term", []corev1.NodeSelectorTerm{{}}, false},
		{"hostname label differs from name", []corev1.NodeSelectorTerm{term(in(corev1.LabelHostname, "host-a"))}, true},
		{"other host", []corev1.NodeSelectorTerm{term(in(corev1.LabelHostname, "host-b"))}, false},
		{"topolvm topology", []corev1.NodeSelectorTerm{term(in("topology.topolvm.io/node", "node-a"))}, true},
		{"shared zone", []corev1.NodeSelectorTerm{term(in("topology.kubernetes.io/zone", "zone-a"))}, false},
		{"AND other constraint fails", []corev1.NodeSelectorTerm{term(in(corev1.LabelHostname, "host-a"), in("topology.kubernetes.io/zone", "zone-b"))}, false},
		{"OR host alternative", []corev1.NodeSelectorTerm{term(in(corev1.LabelHostname, "host-b")), term(in(corev1.LabelHostname, "host-a"))}, true},
		{"node name field", []corev1.NodeSelectorTerm{{MatchFields: []corev1.NodeSelectorRequirement{in("metadata.name", "node-a")}}}, true},
		{"other node field", []corev1.NodeSelectorTerm{{MatchFields: []corev1.NodeSelectorRequirement{in("metadata.name", "node-b")}}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			affinity := &corev1.VolumeNodeAffinity{Required: &corev1.NodeSelector{NodeSelectorTerms: tc.terms}}
			if got := volumeOnHost(affinity, node); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
	if volumeOnHost(nil, node) {
		t.Fatal("unrestricted volume matched host")
	}
}

func TestGetNodeDetailsAndHostVolumes(t *testing.T) {
	hostVolume := &corev1.PersistentVolume{ObjectMeta: metav1.ObjectMeta{Name: "local-a"}, Spec: corev1.PersistentVolumeSpec{NodeAffinity: &corev1.VolumeNodeAffinity{Required: &corev1.NodeSelector{NodeSelectorTerms: []corev1.NodeSelectorTerm{{MatchExpressions: []corev1.NodeSelectorRequirement{{Key: corev1.LabelHostname, Operator: corev1.NodeSelectorOpIn, Values: []string{"host-a"}}}}}}}}}
	node := &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "node-a", Labels: map[string]string{corev1.LabelHostname: "host-a", "team": "infra"}, CreationTimestamp: metav1.NewTime(usageT)}}
	backend := &fakeBackend{respond: func(u *url.URL) (Response, error) {
		q := u.Query().Get("query")
		if !strings.Contains(q, "node_boot_time_seconds") || !strings.Contains(q, `node="node-a"`) {
			t.Errorf("unexpected boot query %s", q)
		}
		return vectorOf(map[string]any{"metric": map[string]string{"node": "node-a"}, "value": []any{1, "1700000000"}}), nil
	}}
	j := &judge{}
	svc := usageService(backend, j)
	client := fake.NewClientset(node, hostVolume, &corev1.PersistentVolume{ObjectMeta: metav1.ObjectMeta{Name: "shared"}})
	svc.Kubernetes = client
	result, err := svc.GetNode(context.Background(), alice, NodeDetailInput{Name: "node-a"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Labels["team"] != "infra" || result.Node.CreationTimestamp != "2026-10-04T10:00:00Z" || result.Node.BootTimeSeconds == nil || *result.Node.BootTimeSeconds != 1700000000 {
		t.Fatalf("node details %+v", result)
	}
	if !result.VolumesAvailable || len(result.PersistentVolumes) != 1 || result.PersistentVolumes[0].Name != "local-a" {
		t.Fatalf("host volumes %+v", result)
	}
	for _, action := range client.Actions() {
		if action.GetResource().Resource == "pods" || action.GetVerb() == "list" && action.GetResource().Resource == "nodes" {
			t.Fatalf("unexpected broad inventory read: %+v", action)
		}
	}
}

func TestGetNodeRBAC(t *testing.T) {
	for _, denyResource := range []string{"nodes", "persistentvolumes"} {
		t.Run(denyResource, func(t *testing.T) {
			j := &judge{answer: func(_ authz.Identity, a authz.Attributes) authz.Verdict {
				if a.Resource == denyResource {
					return authz.No
				}
				return authz.Yes
			}}
			svc := usageService(&fakeBackend{}, j)
			svc.PrometheusURL = ""
			client := fake.NewClientset(&corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "node-a"}})
			svc.Kubernetes = client
			result, err := svc.GetNode(context.Background(), alice, NodeDetailInput{Name: "node-a"})
			if denyResource == "nodes" {
				if err == nil || len(client.Actions()) != 0 {
					t.Fatal("denied node read reached Kubernetes")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if result.VolumesAvailable || len(result.Warnings) == 0 {
				t.Fatalf("denied PV read reported as empty inventory: %+v", result)
			}
			for _, action := range client.Actions() {
				if action.GetResource().Resource == "persistentvolumes" {
					t.Fatal("denied PV read reached Kubernetes")
				}
			}
		})
	}
}
