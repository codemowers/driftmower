package mcpserver

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/workloads"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	discoveryfake "k8s.io/client-go/discovery/fake"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
	metadatafake "k8s.io/client-go/metadata/fake"
)

func TestHelmDeclarationAndSecretEvidence(t *testing.T) {
	ctx := context.Background()
	k := fake.NewClientset()
	k.Discovery().(*discoveryfake.FakeDiscovery).Resources = []*metav1.APIResourceList{{GroupVersion: "helm.cattle.io/v1", APIResources: []metav1.APIResource{{Name: "helmcharts", Kind: "HelmChart", Namespaced: true}}}}
	chart := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "helm.cattle.io/v1", "kind": "HelmChart", "metadata": map[string]any{"name": "web", "namespace": "kube-system"}, "spec": map[string]any{"targetNamespace": "apps", "chart": "oci://example.com/charts/web", "version": "2.0.0", "valuesContent": "private-values"}}}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{helmChartsGVR: "HelmChartList"}, chart)
	secret := func(rev, status string) *metav1.PartialObjectMetadata {
		return &metav1.PartialObjectMetadata{TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Secret"}, ObjectMeta: metav1.ObjectMeta{Name: "sh.helm.release.v1.web.v" + rev, Namespace: "apps", Labels: map[string]string{"owner": "helm", "name": "web", "version": rev, "status": status}}}
	}
	scheme := metadatafake.NewTestScheme()
	_ = metav1.AddMetaToScheme(scheme)
	meta := metadatafake.NewSimpleMetadataClient(scheme, secret("2", "deployed"), secret("10", "failed"))
	scope := &authz.ScopeResolver{Judge: allowAll{}, ListNamespaces: func(context.Context) ([]string, error) { return []string{"kube-system", "apps"}, nil }}
	w := &Workloads{Judge: allowAll{}, Metadata: meta, Cache: &workloads.Cache{Kubernetes: k, Dynamic: dyn, Discovery: k.Discovery(), Scope: scope}}
	roots := []*workloads.Workload{{UID: "root", HelmReleaseName: "web", HelmReleaseNamespace: "apps", HelmChart: "web-1.2.3-1"}}
	out, err := collectHelm(ctx, w, authz.Identity{}, "", roots)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Releases) != 1 {
		t.Fatalf("expected joined release: %+v", out)
	}
	r := out.Releases[0]
	if r.Revision != 10 || r.HelmStatus != "failed" || r.ChartVersion != "1.2.3-1" || r.DesiredVersion != "2.0.0" || len(r.WorkloadUIDs) != 1 {
		t.Fatalf("incorrect release: %+v", r)
	}
	raw, _ := json.Marshal(out)
	if strings.Contains(string(raw), "private-values") {
		t.Fatal("chart values leaked")
	}
	roots = append(roots, &workloads.Workload{UID: "second", HelmReleaseName: "web", HelmReleaseNamespace: "apps", HelmChart: "web-1.3.0"}, &workloads.Workload{UID: "third", HelmReleaseName: "web", HelmReleaseNamespace: "apps", HelmChart: "web-1.3.0"})
	out, err = collectHelm(ctx, w, authz.Identity{}, "", roots)
	if err != nil || out.Releases[0].ChartVersion != "" || len(out.Warnings) == 0 {
		t.Fatalf("conflicting installed evidence must stay unknown: %+v %v", out, err)
	}
}
func TestImageMetadataUsesOCIMetadataAndSourceCRD(t *testing.T) {
	image := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "codemowers.io/v1alpha1", "kind": "ContainerImage", "metadata": map[string]any{"name": "sha256-abc", "annotations": map[string]any{"private-internal": "not-image-metadata"}}, "annotations": map[string]any{"org.opencontainers.image.version": "v1.2.3"}, "labels": map[string]any{"custom": "label"}, "status": map[string]any{"source": "https://github.com/example/app"}, "manifests": []any{map[string]any{"digest": "sha256:platform"}}}}
	source := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "codemowers.io/v1alpha1", "kind": "SourceRepository", "metadata": map[string]any{"name": "github-example-app"}, "spec": map[string]any{"url": "https://github.com/example/app"}}}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{containerImagesGVR: "ContainerImageList", sourceRepositoriesGVR: "SourceRepositoryList"}, image, source)
	w := &Workloads{Judge: allowAll{}, Cache: &workloads.Cache{Dynamic: dyn}}
	out, warnings := imageMetadataIndex(context.Background(), w, authz.Identity{})
	if len(warnings) > 0 {
		t.Fatal(warnings)
	}
	for _, d := range []string{"sha256:abc", "sha256:platform"} {
		m := out[d]
		if m.Labels["custom"] != "label" || m.Labels["org.opencontainers.image.version"] != "v1.2.3" || m.Labels["private-internal"] != "" || len(m.Sources) != 1 || m.Sources[0].Name != "github-example-app" {
			t.Fatalf("bad metadata: %+v", m)
		}
	}
	w.Judge = denyImages{}
	out, _ = imageMetadataIndex(context.Background(), w, authz.Identity{})
	if len(out) > 0 {
		t.Fatal("metadata exposed without permission")
	}
}
