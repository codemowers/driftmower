package mcpserver

import (
	"context"
	"fmt"
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
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadScanUsesBoundTokenAndDistinguishesExpiredAndInvalidArtifacts(t *testing.T) {
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("bound-test-token"), 0600); err != nil {
		t.Fatal(err)
	}
	key := strings.Repeat("a", 64)
	for _, tc := range []struct {
		name string
		code int
		body string
		want string
	}{
		{"complete", 200, `{"bomFormat":"CycloneDX","vulnerabilities":[]}`, "complete"},
		{"larger than old reader limit", 200, `{"bomFormat":"CycloneDX","vulnerabilities":[]}` + strings.Repeat(" ", 17<<20), "complete"},
		{"partial Java coverage", 200, `{"bomFormat":"CycloneDX","properties":[{"name":"driftmower:scan:coverage","value":"partial"}]}`, "partial"},
		{"expired", 404, `not found`, "expired"},
		{"denied", 401, `unauthorized`, "unavailable"},
		{"invalid", 200, `{"token":"not a report"}`, "invalid"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer bound-test-token" {
					t.Error("missing bound token")
				}
				if r.URL.Path != "/v1/sboms/"+key {
					t.Errorf("unexpected path %s", r.URL.Path)
				}
				w.WriteHeader(tc.code)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			status, body := readScan(context.Background(), server.URL, tokenFile, key)
			if status != tc.want {
				t.Fatalf("status %q, want %q", status, tc.want)
			}
			if (body != nil) != (status == "complete" || status == "partial") {
				t.Fatal("only complete artifacts may expose a report")
			}
		})
	}
}

func TestReadScanRejectsUntrustedArtifactKeys(t *testing.T) {
	status, _ := readScan(context.Background(), "http://not-contacted.example", "not-read", "../credentials")
	if status != "invalid" {
		t.Fatalf("unexpected status %s", status)
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
			result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: "get_image_scan", Arguments: map[string]any{"image": imageName, "digest": digest}})
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
