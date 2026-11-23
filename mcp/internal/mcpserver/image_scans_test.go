package mcpserver

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"github.com/codemowers/driftmower/internal/scanner"
	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/workloads"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestReadFindingsUsesBoundTokenAndOneRequest(t *testing.T) {
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("bound-test-token"), 0600); err != nil {
		t.Fatal(err)
	}
	keys := []string{strings.Repeat("a", 64), strings.Repeat("b", 64)}
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer bound-test-token" || r.URL.Path != "/v1/findings" || r.Method != http.MethodPost {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"artifacts":{"` + keys[0] + `":{"coverage":"complete","findings":[{"id":"CVE-1","severity":"HIGH"}]}}}`))
	}))
	defer server.Close()
	found, err := readFindings(context.Background(), server.URL, tokenFile, keys)
	if err != nil || calls != 1 || len(found) != 1 || found[keys[0]].Findings[0].ID != "CVE-1" || found[keys[1]] != nil {
		t.Fatalf("findings %+v, err %v, calls %d", found, err, calls)
	}
	if _, err := readFindings(context.Background(), "", tokenFile, keys); err == nil {
		t.Fatal("an unconfigured scanner must not read as clean")
	}
}

func TestImageScanUsesListPermissionAndRejectsUnauthorizedCallers(t *testing.T) {
	imageName := "sha256-" + strings.Repeat("a", 64)
	digest := "sha256:" + strings.Repeat("b", 64)
	for _, allowed := range []bool{true, false} {
		t.Run(fmt.Sprint(allowed), func(t *testing.T) {
			image := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "codemowers.io/v1alpha1", "kind": "ContainerImage", "metadata": map[string]any{"name": imageName}, "manifests": []any{map[string]any{"digest": digest, "architecture": "amd64"}}}}
			dynamic := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{containerImagesGVR: "ContainerImageList"}, image)
			var judge authz.Judge = allowAll{}
			if !allowed {
				judge = denyImages{}
			}
			server := mcp.NewServer(&mcp.Implementation{Name: "scans", Version: "test"}, nil)
			addImageScanTool(server, &Workloads{Cache: &workloads.Cache{Dynamic: dynamic}, Judge: judge}, auth.Mapping{UsernameClaim: "sub"})
			session := connectTo(t, server)
			result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: "get_image_scans", Arguments: map[string]any{"digests": []string{digest}}})
			if err != nil {
				t.Fatal(err)
			}
			if result.IsError == allowed {
				t.Fatalf("unexpected authorization result: %+v", result)
			}
			actions := dynamic.Actions()
			if !allowed && len(actions) != 0 {
				t.Fatal("unauthorized caller reached ContainerImage data")
			}
			if allowed && (len(actions) != 1 || actions[0].GetVerb() != "list") {
				t.Fatalf("expected only a list action, got %+v", actions)
			}
		})
	}
}

func TestCompressedArtifactProxyPreservesBytesAndEnforcesImageRBAC(t *testing.T) {
	name, digest, key := "sha256-"+strings.Repeat("a", 64), "sha256:"+strings.Repeat("b", 64), strings.Repeat("c", 64)
	var encoded bytes.Buffer
	zipper := gzip.NewWriter(&encoded)
	if _, err := zipper.Write([]byte(`{"bomFormat":"CycloneDX"}`)); err != nil {
		t.Fatal(err)
	}
	if err := zipper.Close(); err != nil {
		t.Fatal(err)
	}
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer scan-token" || r.Header.Get("Accept-Encoding") != "gzip" || r.URL.Path != "/v1/sboms/"+key {
			t.Error("proxy lost bound token or encoding")
		}
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Content-Type", "application/vnd.cyclonedx+json")
		w.Header().Set("ETag", `"artifact"`)
		if r.Header.Get("If-None-Match") == `"artifact"` {
			w.WriteHeader(304)
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(encoded.Len()))
		if _, err := w.Write(encoded.Bytes()); err != nil {
			t.Error(err)
		}
	}))
	defer upstream.Close()
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("scan-token"), 0600); err != nil {
		t.Fatal(err)
	}
	image := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "codemowers.io/v1alpha1", "kind": "ContainerImage", "metadata": map[string]any{"name": name, "annotations": map[string]any{"driftmower.io/sbom-" + scanner.Key(digest, "manifest")[:40]: key}}, "manifests": []any{map[string]any{"digest": digest, "architecture": "amd64"}}}}
	dynamic := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{containerImagesGVR: "ContainerImageList"}, image)
	workload := &Workloads{Cache: &workloads.Cache{Dynamic: dynamic}, Judge: allowAll{}, ScanURL: upstream.URL, ScanTokenFile: tokenFile}
	path := "/api/image-scans/sbom?" + url.Values{"image": {name}, "digest": {digest}, "key": {key}}.Encode()
	request := func(method, path string, conditional bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, nil)
		r.Header.Set("Accept-Encoding", "gzip")
		if conditional {
			r.Header.Set("If-None-Match", `"artifact"`)
		}
		recorder := httptest.NewRecorder()
		serveImageScan(recorder, r, workload, authz.Identity{})
		return recorder
	}
	response := request("GET", path, false)
	if response.Code != 200 || response.Header().Get("Content-Encoding") != "gzip" || !bytes.Equal(response.Body.Bytes(), encoded.Bytes()) {
		t.Fatalf("passthrough changed gzip: %d %v", response.Code, response.Header())
	}
	if response.Header().Get("Cache-Control") != "private, no-cache" || !strings.Contains(response.Header().Get("Vary"), "Authorization") {
		t.Fatal("artifact cache is not private")
	}
	if conditional := request("GET", path, true); conditional.Code != 304 || conditional.Body.Len() != 0 {
		t.Fatal("conditional artifact read failed")
	}
	if head := request("HEAD", path, false); head.Code != 200 || head.Body.Len() != 0 {
		t.Fatal("HEAD transferred an artifact")
	}
	before := calls
	wrong := strings.Replace(path, "key="+key, "key="+strings.Repeat("d", 64), 1)
	if response := request("GET", wrong, false); response.Code != 404 || calls != before {
		t.Fatal("unassociated key reached scanner")
	}
	workload.Judge = denyImages{}
	dynamic.ClearActions()
	if response := request("GET", path, false); response.Code != 403 || calls != before || len(dynamic.Actions()) != 0 {
		t.Fatal("RBAC denial reached image or artifact data")
	}
}

func TestImageScanMetadataDoesNotReadOrDecompressArtifacts(t *testing.T) {
	name, digest, key := "sha256-"+strings.Repeat("a", 64), "sha256:"+strings.Repeat("b", 64), strings.Repeat("c", 64)
	image := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "codemowers.io/v1alpha1", "kind": "ContainerImage", "metadata": map[string]any{"name": name, "annotations": map[string]any{"driftmower.io/sbom-" + scanner.Key(digest, "manifest")[:40]: key}}, "manifests": []any{map[string]any{"digest": digest}}}}
	dynamic := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{containerImagesGVR: "ContainerImageList"}, image)
	server := mcp.NewServer(&mcp.Implementation{Name: "scans", Version: "test"}, nil)
	addImageScanTool(server, &Workloads{Cache: &workloads.Cache{Dynamic: dynamic}, Judge: allowAll{}, ScanURL: "http://must-not-be-contacted.invalid", ScanTokenFile: "must-not-be-read"}, auth.Mapping{UsernameClaim: "sub"})
	session := connectTo(t, server)
	result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: "get_image_scans", Arguments: map[string]any{"digests": []string{digest}}})
	if err != nil || result.IsError {
		t.Fatalf("metadata request: %v %+v", err, result)
	}
	body, err := json.Marshal(result.StructuredContent)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(body, []byte(`"status":"available"`)) || !bytes.Contains(body, []byte("/api/image-scans/sbom?")) || bytes.Contains(body, []byte(`"bom"`)) {
		t.Fatalf("metadata response: %s", body)
	}
}

func TestFilesystemOnlyCycloneDXIsDownloadableWithoutVulnerabilityFindings(t *testing.T) {
	name, digest, key := "sha256-"+strings.Repeat("a", 64), "sha256:"+strings.Repeat("b", 64), strings.Repeat("c", 64)
	image := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "codemowers.io/v1alpha1", "kind": "ContainerImage", "metadata": map[string]any{"name": name, "annotations": map[string]any{"driftmower.io/analysis-" + scanner.Key(digest, "manifest")[:40]: key}}, "manifests": []any{map[string]any{"digest": digest}}}}
	dynamic := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{containerImagesGVR: "ContainerImageList"}, image)
	server := mcp.NewServer(&mcp.Implementation{Name: "scans", Version: "test"}, nil)
	addImageScanTool(server, &Workloads{Cache: &workloads.Cache{Dynamic: dynamic}, Judge: allowAll{}, ScanURL: "http://must-not-be-contacted.invalid", ScanTokenFile: "must-not-be-read"}, auth.Mapping{UsernameClaim: "sub"})
	session := connectTo(t, server)
	result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: "get_image_scans", Arguments: map[string]any{"digests": []string{digest}, "includeFindings": true}})
	if err != nil || result.IsError {
		t.Fatalf("filesystem-only result: %+v %v", result, err)
	}
	body, _ := json.Marshal(result.StructuredContent)
	if !bytes.Contains(body, []byte(`"filesystemOnly":true`)) || !bytes.Contains(body, []byte(`"status":"pending"`)) || !bytes.Contains(body, []byte("/api/image-scans/sbom?")) || bytes.Contains(body, []byte(`"findings"`)) {
		t.Fatalf("filesystem artifact looked like a complete vulnerability scan: %s", body)
	}
}
