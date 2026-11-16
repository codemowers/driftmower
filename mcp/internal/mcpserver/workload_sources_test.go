package mcpserver

import (
	"context"
	"log/slog"
	"strings"
	"testing"

	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/workloads"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
	metadatafake "k8s.io/client-go/metadata/fake"
)

func TestWorkloadSourcesUseRunningDigestAndHonorImageRBAC(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	digest := "sha256:" + strings.Repeat("a", 64)
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "team", UID: "pod"}, Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "web", Image: "nginx:latest"}}}, Status: corev1.PodStatus{ContainerStatuses: []corev1.ContainerStatus{{Name: "web", ImageID: "containerd://" + digest}}}}
	image := func(name, tag, url string) *unstructured.Unstructured {
		return &unstructured.Unstructured{Object: map[string]any{"apiVersion": "codemowers.io/v1alpha1", "kind": "ContainerImage", "metadata": map[string]any{"name": name}, "repoTags": []any{tag}, "status": map[string]any{"source": url}, "manifests": []any{map[string]any{"digest": strings.Replace(name, "sha256-", "sha256:", 1), "layers": []any{map[string]any{"private": "must-not-be-returned"}}}}}}
	}
	source := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "codemowers.io/v1alpha1", "kind": "SourceRepository", "metadata": map[string]any{"name": "nginx-source"}, "spec": map[string]any{"url": "https://github.com/nginx/nginx"}}}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{containerImagesGVR: "ContainerImageList", sourceRepositoriesGVR: "SourceRepositoryList"}, image("sha256-"+strings.Repeat("a", 64), "nginx:old", "https://github.com/nginx/nginx"), image("sha256-"+strings.Repeat("b", 64), "nginx:latest", "https://github.com/wrong/moving-tag"), source)
	k := fake.NewClientset(pod)
	scheme := metadatafake.NewTestScheme()
	_ = metav1.AddMetaToScheme(scheme)
	cache := &workloads.Cache{Kubernetes: k, Metadata: metadatafake.NewSimpleMetadataClient(scheme), Dynamic: dyn, Discovery: k.Discovery(), Judge: allowAll{}, Logger: slog.New(slog.DiscardHandler)}
	cache.Start(ctx)
	w := &Workloads{Cache: cache, Judge: allowAll{}}
	root := &workloads.Workload{UID: "root", Namespace: "team"}
	root.Pods = []string{"web"}
	root.Images = []string{"nginx:latest"}
	rows, warnings, err := workloadSources(ctx, w, authz.Identity{}, []*workloads.Workload{root})
	if err != nil || len(warnings) > 0 {
		t.Fatalf("%v %v", err, warnings)
	}
	if len(rows[0].SourceRepositories) != 1 || rows[0].SourceRepositories[0].Name != "nginx-source" || rows[0].SourceRepositories[0].URL != "https://github.com/nginx/nginx" {
		t.Fatalf("wrong source: %+v", rows[0].SourceRepositories)
	}
	if root.SourceRepositories != nil {
		t.Fatal("mutated cached workload graph")
	}
	before := len(dyn.Actions())
	w.Judge = denyImages{}
	rows, warnings, err = workloadSources(ctx, w, authz.Identity{}, []*workloads.Workload{root})
	if err != nil || len(warnings) == 0 || len(rows[0].SourceRepositories) != 0 || len(dyn.Actions()) != before {
		t.Fatal("image RBAC failed to withhold source links")
	}
}
