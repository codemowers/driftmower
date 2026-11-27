package mcpserver

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/codemowers/driftmower/internal/lifecycle"
	"github.com/codemowers/driftmower/internal/scanner"
	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/workloads"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
	metadatafake "k8s.io/client-go/metadata/fake"
)

type packageLifecycle struct{ staticReports }

func (packageLifecycle) Lifecycles(_ context.Context, queries []lifecycle.Query) (lifecycle.Result, error) {
	out := lifecycle.Result{Matches: map[string]lifecycle.Match{}}
	for _, q := range queries {
		if q.PURL == "pkg:npm/demo" {
			state := "supported"
			if q.Version == "1.0" {
				state = "end-of-life"
			}
			out.Matches[q.Key()] = lifecycle.Match{Product: "demo", Category: "framework", Tags: []string{"frontend"}, State: state}
		}
	}
	return out, nil
}
func TestPackagesRejectUnauthorizedBeforeInventory(t *testing.T) {
	_, err := readPackages(context.Background(), &Workloads{Judge: denyImages{}}, authz.Identity{}, packagesInput{}, "", nil)
	if err == nil {
		t.Fatal("unauthorized package inventory permitted")
	}
}
func TestPackagesAggregateVersionsWithoutReplicasAndScopeConsumers(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	d := "sha256:" + strings.Repeat("a", 64)
	key := strings.Repeat("b", 64)
	pod := func(name, ns string) *corev1.Pod {
		return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name, UID: types.UID("uid-" + name)}, Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "app", Image: "registry.example.com/app:1"}}}, Status: corev1.PodStatus{Phase: corev1.PodRunning, ContainerStatuses: []corev1.ContainerStatus{{Name: "app", ImageID: "registry.example.com/app@" + d}}}}
	}
	kube := fake.NewClientset(pod("one", "team-a"), pod("replica", "team-a"), pod("private", "team-b"))
	meta := metadatafake.NewSimpleMetadataClient(metadatafake.NewTestScheme())
	image := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "codemowers.io/v1alpha1", "kind": "ContainerImage", "metadata": map[string]any{"name": "sha256-" + strings.Repeat("c", 64), "annotations": map[string]any{"driftmower.io/sbom-" + scanner.Key(d, "manifest")[:40]: key}}, "manifests": []any{map[string]any{"digest": d}}}}
	dynamic := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{containerImagesGVR: "ContainerImageList"}, image)
	cache := &workloads.Cache{Kubernetes: kube, Metadata: meta, Dynamic: dynamic, Discovery: kube.Discovery(), Judge: allowAll{}, Logger: slog.New(slog.DiscardHandler), Scope: &authz.ScopeResolver{Judge: allowAll{}, ListNamespaces: func(context.Context) ([]string, error) { return []string{"team-a"}, nil }}}
	cache.Start(ctx)
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer test" {
			t.Error("scanner token missing")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"artifacts": map[string]any{key: scanner.ArtifactPackages{Coverage: "partial", Reason: "java_db_unavailable", Packages: []scanner.Package{{ID: "pkg:npm/demo", PURL: "pkg:npm/demo@1.0", Name: "demo", Ecosystem: "npm", Version: "1.0", Findings: []scanner.Finding{{ID: "CVE-example"}}}, {ID: "pkg:npm/demo", PURL: "pkg:npm/demo@2.0", Name: "demo", Ecosystem: "npm", Version: "2.0"}}}}})
	}))
	defer upstream.Close()
	token := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(token, []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	w := &Workloads{Cache: cache, Judge: allowAll{}, ScanURL: upstream.URL, ScanTokenFile: token}
	out, err := readPackages(ctx, w, authz.Identity{User: "user"}, packagesInput{}, "", packageLifecycle{})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Packages) != 1 || out.Packages[0].Versions != 2 || out.Packages[0].Images != 1 || out.Packages[0].Vulnerabilities != 1 || out.Coverage.Partial != 1 || calls != 1 {
		t.Fatalf("unexpected package summary %+v calls %d", out, calls)
	}
	if !slices.Contains(out.Packages[0].LifecycleStates, "supported") || !slices.Contains(out.Packages[0].LifecycleStates, "end-of-life") {
		t.Fatalf("mixed version states lost: %+v", out.Packages[0])
	}
	if len(out.Packages[0].UsedBy) != 1 || out.Packages[0].UsedBy[0].Repository != "registry.example.com/app" {
		t.Fatal("image references missing or replicas counted twice")
	}
	detail, err := readPackages(ctx, w, authz.Identity{User: "user"}, packagesInput{}, "pkg:npm/demo", packageLifecycle{})
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.Occurrences) != 2 || len(detail.Occurrences[0].Uses) != 2 {
		t.Fatalf("unexpected occurrences %+v", detail.Occurrences)
	}
	server := mcp.NewServer(&mcp.Implementation{Name: "packages", Version: "test"}, nil)
	addPackageTools(server, w, auth.Mapping{UsernameClaim: "sub"}, packageLifecycle{})
	session := connectTo(t, server)
	_, wire := call(t, session, "get_packages", map[string]any{})
	if status, ok := wire["lifecycle"].(map[string]any); ok {
		if _, exists := status["matches"]; exists {
			t.Fatal("list status leaks lifecycle match payload")
		}
	} else {
		t.Fatal("missing lifecycle status")
	}
	_, wire = call(t, session, "get_package", map[string]any{"purl": "pkg:npm/demo"})
	if len(wire["occurrences"].([]any)) != 2 {
		t.Fatal("wire package detail lost versions")
	}
	for _, o := range detail.Occurrences {
		for _, u := range o.Uses {
			if u.Namespace != "team-a" {
				t.Fatal("consumer in inaccessible namespace leaked")
			}
		}
	}
}
