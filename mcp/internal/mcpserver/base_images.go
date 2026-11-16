package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"

	"github.com/codemowers/driftmower/internal/registry"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

type baseRepositoryInput struct {
	Repository string `json:"repository"`
	Digest     string `json:"digest,omitempty"`
	Offset     int    `json:"offset,omitempty"`
	Limit      int    `json:"limit,omitempty"`
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
	mcp.AddTool(s, &mcp.Tool{Name: "list_base_image_repositories", InputSchema: noArguments(), Title: "List scraped base image repositories", Description: "List the configured public base-image catalog, last crawl times, counts and errors. Includes observedAt and live registries with idle/scraping/throttled state, active repositories, retryAt, latest request/error and authentication mode. Reads only the registry scraper, independently of installed ContainerImages.", Annotations: readOnly("List public base images")}, func(ctx context.Context, req *mcp.CallToolRequest, _ noInput) (*mcp.CallToolResult, map[string]any, error) {
		if err := requireCaller(req); err != nil {
			return nil, nil, err
		}
		var out map[string]any
		err := w.Registry.JSON(ctx, http.MethodGet, "/v1/repositories", nil, &out)
		return nil, out, err
	})
	mcp.AddTool(s, &mcp.Tool{Name: "get_base_image_repository", InputSchema: inputSchema[baseRepositoryInput](nil), Title: "Read scraped image tags and platforms", Description: "Read a page of public registry image metadata: tag aliases, platform manifests, amd64/arm64 variants, ordered layer digests and DiffIDs, config digest, labels, entrypoint/cmd and OCI creation time. offset is nonnegative; limit defaults to 50, maximum 100. No cluster inventory or live registry request.", Annotations: readOnly("Read base image repository")}, func(ctx context.Context, req *mcp.CallToolRequest, in baseRepositoryInput) (*mcp.CallToolResult, *registry.RepositoryPage, error) {
		if err := requireCaller(req); err != nil {
			return nil, nil, err
		}
		if in.Limit == 0 {
			in.Limit = 50
		}
		if in.Offset < 0 || in.Limit < 1 || in.Limit > 100 {
			return nil, nil, fmt.Errorf("invalid base image pagination")
		}
		q := url.Values{"name": {in.Repository}, "digest": {in.Digest}, "offset": {strconv.Itoa(in.Offset)}, "limit": {strconv.Itoa(in.Limit)}}
		var out registry.RepositoryPage
		err := w.Registry.JSON(ctx, http.MethodGet, "/v1/repository?"+q.Encode(), nil, &out)
		return nil, &out, err
	})
	mcp.AddTool(s, &mcp.Tool{Name: "get_base_image_hierarchy", InputSchema: inputSchema[baseHierarchyInput](nil), Title: "Trace image filesystem ancestry", Description: "Match ordered platform image layers against the scraped public catalog. Pass images with digest, platform {os,architecture,variant}, and layers [{digest,diffID}]; get_image_metadata supplies this shape as imageInfo.platforms. Returns scratch (the empty filesystem root) then known full image chains matching progressively longer prefixes. Each stage can have alternative repositories, versions and tag aliases. Shared layers establish filesystem lineage, not a unique Dockerfile FROM. Missing intermediate images remain unknown. At most 16 platforms, 256 layers each. Never fetches registries during a query.", Annotations: readOnly("Read base image hierarchy")}, func(ctx context.Context, req *mcp.CallToolRequest, in baseHierarchyInput) (*mcp.CallToolResult, *registry.HierarchyResult, error) {
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
	mcp.AddTool(s, &mcp.Tool{Name: "get_base_image_config", InputSchema: inputSchema[baseConfigInput](nil), Title: "Read stored OCI image config", Description: "Download the verified OCI config stored by the registry scraper. Returns digest and gzipBase64 containing the exact original config.json.gz, including the complete published config and build history. No live registry fetch.", Annotations: readOnly("Read stored image config")}, func(ctx context.Context, req *mcp.CallToolRequest, in baseConfigInput) (*mcp.CallToolResult, map[string]any, error) {
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
