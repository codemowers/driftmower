package mcpserver

import (
	"context"
	"github.com/codemowers/driftmower/internal/imageanalysis"
	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/workloads"
	"github.com/modelcontextprotocol/go-sdk/mcp"
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

func TestAnalysisReaderUsesBoundTokenAndRejectsBadProfiles(t *testing.T) {
	token := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(token, []byte("test-bound-token"), 0600); err != nil {
		t.Fatal(err)
	}
	valid := true
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-bound-token" || r.URL.Path != "/v1/sboms/"+strings.Repeat("a", 64) {
			t.Error("analysis request not bound to token/key")
		}
		if valid {
			body, err := imageanalysis.MergeCycloneDX(nil, imageanalysis.Report{SchemaVersion: 1, NewestFileLimit: 1000, ObservedAt: "2026-11-20T00:00:00Z"}, "pending")
			if err != nil {
				t.Error(err)
			}
			if _, err := w.Write(body); err != nil {
				t.Error(err)
			}
		} else {
			if _, err := w.Write([]byte(`{"schemaVersion":99}`)); err != nil {
				t.Error(err)
			}
		}
	}))
	defer upstream.Close()
	w := &Workloads{ScanURL: upstream.URL, ScanTokenFile: token}
	if readImageAnalysis(context.Background(), w, strings.Repeat("a", 64)) == nil {
		t.Fatal("valid report unavailable")
	}
	valid = false
	if readImageAnalysis(context.Background(), w, strings.Repeat("a", 64)) != nil {
		t.Fatal("unknown report schema accepted")
	}
}
func TestAnalysisRejectsUnauthorizedBeforeReadingImages(t *testing.T) {
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{containerImagesGVR: "ContainerImageList"})
	server := mcp.NewServer(&mcp.Implementation{Name: "analysis", Version: "test"}, nil)
	addImageAnalysisTool(server, &Workloads{Cache: &workloads.Cache{Dynamic: dyn}, Judge: denyImages{}}, auth.Mapping{UsernameClaim: "sub"})
	session := connectTo(t, server)
	result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: "get_image_analysis", Arguments: map[string]any{"digests": []string{"sha256:" + strings.Repeat("a", 64)}}})
	if err != nil || !result.IsError || len(dyn.Actions()) != 0 {
		t.Fatalf("unauthorized access reached image data: %v %+v", err, result)
	}
}
