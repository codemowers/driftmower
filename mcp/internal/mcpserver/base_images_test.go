package mcpserver

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/codemowers/driftmower/internal/registry"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestBaseImageToolsReadOnlyScraperUsingDownstreamToken(t *testing.T) {
	store, err := registry.OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	digest := "sha256:" + strings.Repeat("a", 64)
	base := registry.Image{Repository: "docker.io/library/alpine", Digest: digest, Tags: []string{"3.21.3"}, Platform: registry.Platform{OS: "linux", Architecture: "arm64", Variant: "v8"}, Layers: []registry.Layer{{Digest: "sha256:" + strings.Repeat("b", 64), DiffID: "sha256:" + strings.Repeat("c", 64)}}}
	if err := store.Put(&registry.Repository{Repository: base.Repository, Images: []registry.Image{base}}); err != nil {
		t.Fatal(err)
	}
	config := []byte(`{ "architecture":"arm64", "os":"linux" }`)
	sum := sha256.Sum256(config)
	configDigest := "sha256:" + hex.EncodeToString(sum[:])
	if err := store.WriteObject("config", configDigest, config); err != nil {
		t.Fatal(err)
	}
	api := &registry.API{Store: store, Allowed: []string{"mcp-service-account"}, Authenticate: func(_ context.Context, token string) (string, error) {
		if token != "projected-registry-token" {
			return "", errors.New("wrong token audience")
		}
		return "mcp-service-account", nil
	}}
	backend := httptest.NewServer(api.Handler())
	defer backend.Close()
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("projected-registry-token\n"), 0600); err != nil {
		t.Fatal(err)
	}
	server := mcp.NewServer(&mcp.Implementation{Name: "base-images", Version: "test"}, nil)
	addBaseImageTools(server, &Workloads{Registry: &registry.Reader{URL: backend.URL, TokenFile: tokenFile, HTTP: backend.Client()}})
	session := connectTo(t, server)
	for _, tc := range []struct {
		name  string
		args  map[string]any
		field string
	}{
		{"list_base_image_repositories", map[string]any{}, "repositories"},
		{"get_base_image_repository", map[string]any{"repository": base.Repository, "digest": digest}, "images"},
		{"get_base_image_hierarchy", map[string]any{"images": []registry.Target{{Digest: digest, Platform: base.Platform, Layers: base.Layers}}}, "hierarchies"},
		{"get_base_image_config", map[string]any{"digest": configDigest}, "gzipBase64"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: tc.name, Arguments: tc.args})
			if err != nil {
				t.Fatal(err)
			}
			if result.IsError {
				t.Fatalf("tool failed: %+v", result)
			}
			body, err := json.Marshal(result.StructuredContent)
			if err != nil {
				t.Fatal(err)
			}
			var out map[string]json.RawMessage
			if err := json.Unmarshal(body, &out); err != nil {
				t.Fatal(err)
			}
			if _, ok := out[tc.field]; !ok {
				t.Fatalf("scraper JSON shape lost: %s", body)
			}
		})
	}
}

func TestImagePlatformsPreserveOrderedLayerMetadata(t *testing.T) {
	image := &unstructured.Unstructured{Object: map[string]any{"manifests": []any{map[string]any{"digest": "sha256:target", "architecture": "arm64", "variant": "v8", "layers": []any{map[string]any{"digest": "sha256:one", "diffID": "sha256:uncompressed-one", "size": int64(12)}, map[string]any{"digest": "sha256:two", "diffID": "sha256:uncompressed-two", "size": int64(34)}}}}}}
	platforms := imagePlatforms(image)
	if len(platforms) != 1 || platforms[0].Platform.OS != "linux" || platforms[0].Platform.Variant != "v8" || len(platforms[0].Layers) != 2 || platforms[0].Layers[1].DiffID != "sha256:uncompressed-two" {
		t.Fatalf("platform metadata is not scraper-compatible: %+v", platforms)
	}
}
