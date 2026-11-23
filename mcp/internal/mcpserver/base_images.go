package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"

	"github.com/codemowers/driftmower/internal/registry"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

type baseRepositoryInput struct {
	Repository string `json:"repository"`
	Digest     string `json:"digest,omitempty"`
}
type baseHierarchyInput struct {
	Images []registry.Target `json:"images"`
}
type baseConfigInput struct {
	Digest string `json:"digest"`
}

func addBaseImageTools(s *mcp.Server, w *Workloads) {
	if w.Registry == nil {
		return
	}
	mcp.AddTool(s, &mcp.Tool{Name: "list_base_image_repositories", InputSchema: noArguments(), Title: "List scraped base image repositories", Description: "Configured public base-image repositories with crawl state and per-registry scraper status.", Annotations: readOnly("List public base images")}, func(ctx context.Context, req *mcp.CallToolRequest, _ noInput) (*mcp.CallToolResult, map[string]any, error) {
		if err := requireCaller(req); err != nil {
			return nil, nil, err
		}
		var out map[string]any
		err := w.Registry.JSON(ctx, http.MethodGet, "/v1/repositories", nil, &out)
		return nil, out, err
	})
	mcp.AddTool(s, &mcp.Tool{Name: "get_base_image_repository", InputSchema: inputSchema[baseRepositoryInput](nil), Title: "Read scraped image tags and platforms", Description: "Scraped public image tags of one repository: platforms, layers, DiffIDs, config digest, labels and creation time. Pass digest for one image.", Annotations: readOnly("Read base image repository")}, func(ctx context.Context, req *mcp.CallToolRequest, in baseRepositoryInput) (*mcp.CallToolResult, *registry.RepositoryDetail, error) {
		if err := requireCaller(req); err != nil {
			return nil, nil, err
		}
		q := url.Values{"name": {in.Repository}, "digest": {in.Digest}}
		var out registry.RepositoryDetail
		err := w.Registry.JSON(ctx, http.MethodGet, "/v1/repository?"+q.Encode(), nil, &out)
		return nil, &out, err
	})
	mcp.AddTool(s, &mcp.Tool{Name: "get_base_image_hierarchy", InputSchema: inputSchema[baseHierarchyInput](nil), Title: "Trace image filesystem ancestry", Description: "Match platform image layers against the scraped base-image catalog, returning image chains from scratch upward with alternatives per stage. Pass imageInfo.platforms from get_image_metadata. Shared layers show lineage, not the Dockerfile FROM.", Annotations: readOnly("Read base image hierarchy")}, func(ctx context.Context, req *mcp.CallToolRequest, in baseHierarchyInput) (*mcp.CallToolResult, *registry.HierarchyResult, error) {
		if err := requireCaller(req); err != nil {
			return nil, nil, err
		}
		if len(in.Images) < 1 || len(in.Images) > 16 {
			return nil, nil, fmt.Errorf("expected 1 to 16 platform images")
		}
		for _, image := range in.Images {
			if len(image.Layers) > 256 {
				return nil, nil, fmt.Errorf("too many layers")
			}
		}
		var out registry.HierarchyResult
		err := w.Registry.JSON(ctx, http.MethodPost, "/v1/hierarchy", in, &out)
		return nil, &out, err
	})
	mcp.AddTool(s, &mcp.Tool{Name: "get_base_image_config", InputSchema: inputSchema[baseConfigInput](nil), Title: "Read stored OCI image config", Description: "Stored original config.json.gz of a scraped image, base64-encoded.", Annotations: readOnly("Read stored image config")}, func(ctx context.Context, req *mcp.CallToolRequest, in baseConfigInput) (*mcp.CallToolResult, map[string]any, error) {
		if err := requireCaller(req); err != nil {
			return nil, nil, err
		}
		var out map[string]any
		err := w.Registry.JSON(ctx, http.MethodGet, "/v1/configs/"+url.PathEscape(in.Digest)+"?encoding=base64", nil, &out)
		return nil, out, err
	})
}

func imagePlatforms(image *unstructured.Unstructured) []registry.Target {
	manifests, _, _ := unstructured.NestedSlice(image.Object, "manifests")
	out := []registry.Target{}
	for _, raw := range manifests {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		digest, _ := m["digest"].(string)
		arch, _ := m["architecture"].(string)
		variant, _ := m["variant"].(string)
		os, _ := m["os"].(string)
		if os == "" {
			os = "linux"
		}
		layers, found, err := unstructured.NestedSlice(m, "layers")
		if err != nil || !found || digest == "" || arch == "" {
			continue
		}
		body, err := json.Marshal(layers)
		if err != nil {
			continue
		}
		var parsed []registry.Layer
		if json.Unmarshal(body, &parsed) != nil {
			continue
		}
		out = append(out, registry.Target{Digest: digest, Platform: registry.Platform{OS: os, Architecture: arch, Variant: variant}, Layers: parsed})
	}
	return out
}
