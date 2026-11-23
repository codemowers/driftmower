package mcpserver

import (
	"context"
	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/workloads"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"testing"
)

type denyProcessReader struct{}

func (denyProcessReader) MayPerform(ctx context.Context, id authz.Identity, a authz.Attributes) authz.Judgement {
	if a.Resource == "podprocesses" {
		return authz.Judgement{Verdict: authz.No}
	}
	return allowAll{}.MayPerform(ctx, id, a)
}
func TestPodProcessReadsRequireOwnPodUIDAndProcessPermission(t *testing.T) {
	for _, mode := range []string{"allowed", "denied", "wrong-owner", "replaced-pod"} {
		t.Run(mode, func(t *testing.T) {
			podUID := "p1"
			if mode == "replaced-pod" {
				podUID = "new-pod"
			}
			ownerUID := "p1"
			if mode == "wrong-owner" {
				ownerUID = "other-pod"
			}
			pod := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "v1", "kind": "Pod", "metadata": map[string]any{"name": "api", "namespace": "team", "uid": podUID}}}
			process := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "codemowers.io/v1alpha1", "kind": "PodProcess", "metadata": map[string]any{"name": "pod-p1", "namespace": "team", "ownerReferences": []any{map[string]any{"apiVersion": "v1", "kind": "Pod", "name": "api", "uid": ownerUID}}}, "spec": map[string]any{"podUID": "p1", "podName": "api"}, "observation": map[string]any{"containers": []any{map[string]any{"name": "app", "hostUID": int64(500000)}}}}}
			dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{{Version: "v1", Resource: "pods"}: "PodList"}, pod, process)
			var judge authz.Judge = allowAll{}
			if mode == "denied" {
				judge = denyProcessReader{}
			}
			server := mcp.NewServer(&mcp.Implementation{Name: "processes", Version: "test"}, nil)
			addPodProcessesTool(server, &Workloads{Cache: &workloads.Cache{Dynamic: dyn}, Judge: judge}, auth.Mapping{UsernameClaim: "sub"})
			session := connectTo(t, server)
			result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: "get_pod_processes", Arguments: map[string]any{"namespace": "team", "name": "api", "uid": "p1"}})
			if err != nil {
				t.Fatal(err)
			}
			if result.IsError != (mode != "allowed") {
				t.Fatalf("incorrect process access for %s: %+v", mode, result)
			}
			if mode == "denied" && len(dyn.Actions()) != 0 {
				t.Fatal("unauthorized caller reached process data")
			}
		})
	}
}
