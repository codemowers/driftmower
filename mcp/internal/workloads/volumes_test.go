package workloads

import (
	"context"
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	dynamicfake "k8s.io/client-go/dynamic/fake"

	"github.com/codemowers/driftmower/mcp/internal/authz"
)

func volumeActions(t *testing.T, allowExpansion bool) (*Actions, *dynamicfake.FakeDynamicClient) {
	t.Helper()
	claim := object("v1", "PersistentVolumeClaim", "data", map[string]any{
		"spec":   map[string]any{"storageClassName": "fast", "resources": map[string]any{"requests": map[string]any{"storage": "10Gi"}}},
		"status": map[string]any{"phase": "Bound"},
	})
	class := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "storage.k8s.io/v1", "kind": "StorageClass",
		"metadata": map[string]any{"name": "fast"}, "allowVolumeExpansion": allowExpansion}}
	kinds := map[schema.GroupVersionResource]string{pvcGVR: "PersistentVolumeClaimList", storageClassGVR: "StorageClassList"}
	client := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), kinds, claim, class)

	return &Actions{clientFor: func(authz.Identity) (dynamic.Interface, error) { return client, nil }, serverClient: client}, client
}

func expandTo(storage string) ExpandInput {
	return ExpandInput{Target: Target{Namespace: "team-a", Name: "data", UID: "data-uid"}, Storage: storage}
}

func storageOf(t *testing.T, client dynamic.Interface) string {
	t.Helper()
	obj, err := client.Resource(pvcGVR).Namespace("team-a").Get(context.Background(), "data", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	s, _, _ := unstructured.NestedString(obj.Object, "spec", "resources", "requests", "storage")

	return s
}

func TestExpandIsIdempotent(t *testing.T) {
	a, client := volumeActions(t, true)
	for range 2 {
		if _, err := a.Expand(context.Background(), expandTo("12Gi"), authz.Identity{User: "alice"}); err != nil {
			t.Fatal(err)
		}
	}
	if got := storageOf(t, client); got != "12Gi" {
		t.Fatalf("storage = %s, want 12Gi after two identical submissions", got)
	}
	r, err := a.Expand(context.Background(), expandTo("12Gi"), authz.Identity{User: "alice"})
	if err != nil || r.Status != "unchanged" {
		t.Fatalf("repeat = %+v, %v; want unchanged", r, err)
	}
}

func TestExpandRefusals(t *testing.T) {
	a, _ := volumeActions(t, true)
	if _, err := a.Expand(context.Background(), expandTo("21Gi"), authz.Identity{}); err == nil || !strings.Contains(err.Error(), "doubles") {
		t.Fatalf("over double: %v", err)
	}
	if _, err := a.Expand(context.Background(), expandTo("bogus"), authz.Identity{}); err == nil {
		t.Fatal("invalid quantity accepted")
	}
	stale := expandTo("12Gi")
	stale.UID = "other"
	if _, err := a.Expand(context.Background(), stale, authz.Identity{}); err == nil {
		t.Fatal("replaced claim accepted")
	}
	b, _ := volumeActions(t, false)
	if _, err := b.Expand(context.Background(), expandTo("12Gi"), authz.Identity{}); err == nil || !strings.Contains(err.Error(), "does not allow") {
		t.Fatalf("non-expandable class: %v", err)
	}
}
