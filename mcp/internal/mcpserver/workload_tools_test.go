package mcpserver

import (
	"context"
	"log/slog"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
	metadatafake "k8s.io/client-go/metadata/fake"

	"github.com/codemowers/driftmower-mcp/internal/auth"
	"github.com/codemowers/driftmower-mcp/internal/authz"
	"github.com/codemowers/driftmower-mcp/internal/cluster"
	"github.com/codemowers/driftmower-mcp/internal/workloads"
)

func TestWorkloadTools(t *testing.T) {
	logger := slog.New(slog.DiscardHandler)
	k := fake.NewClientset(&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "team-a", Name: "debug", UID: "p1"}})
	scheme := metadatafake.NewTestScheme()
	_ = metav1.AddMetaToScheme(scheme)
	meta := metadatafake.NewSimpleMetadataClient(scheme,
		&metav1.PartialObjectMetadata{TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Pod"}, ObjectMeta: metav1.ObjectMeta{Namespace: "team-a", Name: "debug", UID: "p1"}},
		&metav1.PartialObjectMetadata{TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Secret"}, ObjectMeta: metav1.ObjectMeta{Namespace: "team-a", Name: "token", UID: "s1",
			OwnerReferences: []metav1.OwnerReference{{APIVersion: "example.com/v1", Kind: "Widget", Name: "w", UID: "w1"}}}},
	)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	c := &workloads.Cache{Kubernetes: k, Metadata: meta, Dynamic: dynamicfake.NewSimpleDynamicClient(runtime.NewScheme()),
		Discovery: k.Discovery(), Judge: allowAll{}, Logger: logger,
		Scope: &authz.ScopeResolver{ListNamespaces: func(context.Context) ([]string, error) { return []string{"team-a"}, nil }, Judge: allowAll{}}}
	c.Start(ctx)
	id := "bravo.example.com"
	s := connectTo(t, New(Deps{
		Cluster: cluster.NewIdentity(&id, nil, ""), Version: "test", Logger: logger,
		Mapping:   auth.Mapping{UsernameClaim: "sub"},
		Workloads: &Workloads{Cache: c, Metadata: meta, Judge: allowAll{}},
	}))

	text, out := call(t, s, "get_workloads", map[string]any{"namespace": "team-a"})
	if !strings.HasPrefix(text, "0 workloads; 1 namespace orphan buckets.") {
		t.Errorf("summary = %q", text)
	}
	bucket := out["workloads"].([]any)[0].(map[string]any)
	if bucket["standalonePods"].([]any)[0].(map[string]any)["name"] != "debug" ||
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
}
