package drifthistory

import (
	"context"
	"github.com/codemowers/driftmower/internal/crawler"
	"github.com/codemowers/driftmower/mcp/internal/workloads"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes/fake"
	"strings"
	"testing"
	"time"
)

func TestUnknownCoverageAndStableIdentity(t *testing.T) {
	inv := &workloads.Inventory{Workloads: []*workloads.Workload{{Name: "api", Kind: "Deployment", Namespace: "team", UID: "root-uid", Dependencies: workloads.Dependencies{Images: []string{"example.com/api:v1", "example.com/unknown:v2"}}}}}
	reports := []crawler.SourceReport{{URL: "https://example.com/api", CheckedAt: time.Unix(1234, 0), Deployed: []crawler.DeployedVersion{{Version: "v1", References: []string{"example.com/api:v1"}, Behind: 3}}}}
	output := Render(inv, reports)
	if !strings.Contains(output, `image="example.com/api:v1"`) || !strings.Contains(output, "} 3\n") || !strings.Contains(output, `status="unknown",reason="no_source_match"`) || !strings.Contains(output, `uid="root-uid"`) {
		t.Fatal(output)
	}
	if strings.Count(output, "driftmower_version_releases_behind{") != 1 || strings.Contains(output, "} -1\n") {
		t.Fatal("unknown must not be a numeric drift sample", output)
	}
	reports[0].Errors = []string{"crawl failed"}
	output = Render(inv, reports)
	if strings.Contains(output, "driftmower_version_releases_behind{") || !strings.Contains(output, `reason="crawl_error"`) {
		t.Fatal("incomplete crawl recorded known drift", output)
	}
	if strings.Contains(output, "dollars") || strings.Contains(output, "hours") {
		t.Fatal("cost estimates must not be metrics")
	}
}

func TestRunningDigestsAndReplicaCounts(t *testing.T) {
	root := &workloads.Workload{Kind: "Deployment", Namespace: "team", Name: "api", UID: "owner", Dependencies: workloads.Dependencies{Pods: []string{"a", "b"}, Images: []string{"example.com/api:latest"}}}
	pod := func(name, digest string) *corev1.Pod {
		return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "team", Name: name, UID: types.UID(name)}, Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "app", Image: "example.com/api:latest"}}}, Status: corev1.PodStatus{ContainerStatuses: []corev1.ContainerStatus{{Name: "app", ImageID: "example.com/api@" + digest}}}}
	}
	e := Exporter{Kubernetes: fake.NewClientset(pod("a", "sha256:old"), pod("b", "sha256:old"))}
	inv, counts, err := e.running(context.Background(), &workloads.Inventory{Workloads: []*workloads.Workload{root}})
	if err != nil {
		t.Fatal(err)
	}
	reports := []crawler.SourceReport{{CheckedAt: time.Now(), Deployed: []crawler.DeployedVersion{{References: []string{"example.com/api:latest"}, Behind: 0}}}}
	output := render(inv, reports, counts)
	if !strings.Contains(output, `image="example.com/api@sha256:old"`) || !strings.Contains(output, "} 2\n") {
		t.Fatal(output)
	}
	if !strings.Contains(output, `status="unknown",reason="no_source_match"`) {
		t.Fatal("unrecognized digest must remain unknown", output)
	}
	if root.Images[0] != "example.com/api:latest" {
		t.Fatal("exporter mutated shared inventory")
	}
}

func TestImageCreatedUsesOnlyOCILabel(t *testing.T) {
	images := []unstructured.Unstructured{
		{Object: map[string]any{"metadata": map[string]any{"name": "sha256-valid"}, "labels": map[string]any{"org.opencontainers.image.created": "2026-01-02T03:04:05Z"}}},
		{Object: map[string]any{"metadata": map[string]any{"name": "sha256-missing"}, "created": "2026-01-02T03:04:05Z"}},
		{Object: map[string]any{"metadata": map[string]any{"name": "sha256-invalid"}, "labels": map[string]any{"org.opencontainers.image.created": "yesterday"}}},
	}
	timestamps := imageCreatedIndex(images)
	if len(timestamps) != 1 || timestamps["sha256:valid"] != 1767323045 {
		t.Fatal(timestamps)
	}
	inv := &workloads.Inventory{Workloads: []*workloads.Workload{{Name: "api", Namespace: "team", Kind: "Deployment", Dependencies: workloads.Dependencies{Images: []string{"example.com/api@sha256:valid", "example.com/api@sha256:missing"}}}}}
	output := render(inv, nil, nil, timestamps)
	if strings.Count(output, "driftmower_image_created_timestamp_seconds{") != 1 || strings.Contains(output, "} -1\n") {
		t.Fatal(output)
	}
}
