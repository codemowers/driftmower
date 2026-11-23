package mcpserver

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
	metadatafake "k8s.io/client-go/metadata/fake"

	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/cluster"
	"github.com/codemowers/driftmower/mcp/internal/workloads"
)

func TestWorkloadTools(t *testing.T) {
	logger := slog.New(slog.DiscardHandler)
	k := fake.NewClientset(&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "team-a", Name: "debug", UID: "p1"}},
		&networkingv1.Ingress{ObjectMeta: metav1.ObjectMeta{Namespace: "team-a", Name: "web"}, Spec: networkingv1.IngressSpec{
			TLS:   []networkingv1.IngressTLS{{Hosts: []string{"web.example.com"}}},
			Rules: []networkingv1.IngressRule{{Host: "web.example.com"}, {Host: "*.example.com"}},
		}})
	scheme := metadatafake.NewTestScheme()
	_ = metav1.AddMetaToScheme(scheme)
	meta := metadatafake.NewSimpleMetadataClient(scheme,
		&metav1.PartialObjectMetadata{TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Pod"}, ObjectMeta: metav1.ObjectMeta{Namespace: "team-a", Name: "debug", UID: "p1"}},
		&metav1.PartialObjectMetadata{TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Secret"}, ObjectMeta: metav1.ObjectMeta{Namespace: "team-a", Name: "token", UID: "s1",
			OwnerReferences: []metav1.OwnerReference{{APIVersion: "example.com/v1", Kind: "Widget", Name: "w", UID: "w1"}}}},
	)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	c := &workloads.Cache{Kubernetes: k, Metadata: meta, Dynamic: dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{containerImagesGVR: "ContainerImageList", sourceRepositoriesGVR: "SourceRepositoryList"}),
		Discovery: k.Discovery(), Judge: allowAll{}, Logger: logger,
		Scope: &authz.ScopeResolver{ListNamespaces: func(context.Context) ([]string, error) { return []string{"team-a"}, nil }, Judge: allowAll{}}}
	c.Start(ctx)
	id := "bravo.example.com"
	s := connectTo(t, New(Deps{
		Cluster: cluster.NewIdentity(&id, nil, ""), Version: "test", Logger: logger,
		Mapping:   auth.Mapping{UsernameClaim: "sub"},
		Workloads: &Workloads{Cache: c, Metadata: meta, Judge: allowAll{}},
		Findings:  staticReports{},
	}))

	_, initialStatus := call(t, s, "get_inventory_status", map[string]any{})
	if initialStatus["imageUsages"] != nil || len(k.Actions()) != 0 || len(meta.Actions()) != 0 {
		t.Fatal("connection status triggered cluster inventory reads")
	}
	text, out := call(t, s, "get_workloads", map[string]any{"namespace": "team-a"})
	if !strings.HasPrefix(text, "1 owners.") || out["orphans"] != nil {
		t.Errorf("summary = %q, orphans without asking: %v", text, out["orphans"])
	}
	if owner := out["owners"].([]any)[0].(map[string]any); owner["kind"] != "Pod" || owner["name"] != "debug" || owner["pods"] != nil {
		t.Errorf("a standalone Pod must be its own owner: %v", owner)
	}
	_, out = call(t, s, "get_workloads", map[string]any{"namespace": "team-a", "includeOrphans": true})
	bucket := out["orphans"].([]any)[0].(map[string]any)
	if bucket["standalonePods"] != nil ||
		bucket["orphaned"].(map[string]any)["Widget.example.com"].(map[string]any)["w"].(map[string]any)["secrets"].([]any)[0] != "token" {
		t.Errorf("bucket = %v", bucket)
	}

	_, out = call(t, s, "list_pods", map[string]any{"namespace": "team-a"})
	if pods := out["pods"].([]any); len(pods) != 1 || pods[0] != "debug" {
		t.Errorf("pods = %v", out)
	}

	tools, _ := s.ListTools(context.Background(), nil)
	for _, tool := range tools.Tools {
		if tool.Name == "restart_workload" || tool.Name == "terminate_pod" {
			t.Errorf("%s registered without actions", tool.Name)
		}
	}
	_, status := call(t, s, "get_inventory_status", map[string]any{})
	if status["clusterContext"] != "bravo.example.com" || status["imageUsages"] != nil {
		t.Fatalf("expected cheap status: %v", status)
	}
	for _, tool := range tools.Tools {
		if tool.Name == "get_dashboard_snapshot" {
			t.Fatal("giant snapshot tool is still registered")
		}
	}

	for i := 0; i < 105; i++ {
		_, err := k.CoreV1().Pods("team-a").Create(ctx, &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("bulk-%03d", i), Namespace: "team-a", UID: types.UID(fmt.Sprintf("bulk-%03d", i))}}, metav1.CreateOptions{})
		if err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		rows, _, err := c.Pods(ctx, "team-a", authz.Identity{})
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) == 106 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("Pod watch only observed %d", len(rows))
		}
		time.Sleep(10 * time.Millisecond)
	}
	_, all := call(t, s, "get_workloads", map[string]any{"namespace": "team-a"})
	if len(all["owners"].([]any)) != 106 {
		t.Fatal("inventory was truncated", len(all["owners"].([]any)))
	}
	_, apps := call(t, s, "list_applications", map[string]any{"namespace": "team-a"})
	entries := apps["applications"].([]any)
	if len(entries) != 1 || entries[0].(map[string]any)["url"] != "https://web.example.com/" {
		t.Fatalf("expected concrete TLS ingress URL: %v", entries)
	}
	denied := connectTo(t, New(Deps{
		Cluster: cluster.NewIdentity(&id, nil, ""), Version: "test", Logger: logger,
		Mapping:   auth.Mapping{UsernameClaim: "sub"},
		Workloads: &Workloads{Cache: c, Metadata: meta, Judge: denyIngresses{}},
	}))
	_, hidden := call(t, denied, "list_applications", map[string]any{"namespace": "team-a"})
	if len(hidden["applications"].([]any)) != 0 || len(hidden["warnings"].([]any)) == 0 {
		t.Fatalf("ingress denial must withhold endpoints and report the gap: %v", hidden)
	}
}

type denyIngresses struct{}

func (denyIngresses) MayPerform(_ context.Context, _ authz.Identity, a authz.Attributes) authz.Judgement {
	if a.Resource == "ingresses" {
		return authz.Judgement{Verdict: authz.No}
	}
	return authz.Judgement{Verdict: authz.Yes}
}
