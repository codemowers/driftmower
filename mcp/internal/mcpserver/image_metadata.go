package mcpserver

import (
	"context"
	"fmt"
	"github.com/codemowers/driftmower/internal/registry"
	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"net/url"
	"os"
	"sort"
	"strings"

	"github.com/codemowers/driftmower/mcp/internal/authz"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

var containerImagesGVR = schema.GroupVersionResource{Group: "codemowers.io", Version: "v1alpha1", Resource: "containerimages"}
var sourceRepositoriesGVR = schema.GroupVersionResource{Group: "codemowers.io", Version: "v1alpha1", Resource: "sourcerepositories"}

type sourceLink struct {
	Name string `json:"name,omitempty"`
	URL  string `json:"url"`
}
type imageMetadata struct {
	Labels           map[string]string `json:"labels,omitempty"`
	Sources          []sourceLink      `json:"sourceRepositories,omitempty"`
	ContainerImage   string            `json:"containerImage"`
	SBOMArtifacts    []string          `json:"sbomArtifacts,omitempty"`
	Platforms        []registry.Target `json:"platforms,omitempty"`
	ScannerNamespace string            `json:"scannerNamespace,omitempty"`
}

func httpURL(raw string) bool {
	u, e := url.Parse(raw)
	return e == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" && u.User == nil
}
func imageMetadataIndex(ctx context.Context, w *Workloads, id authz.Identity) (map[string]imageMetadata, []string) {
	return selectedImageMetadata(ctx, w, id, nil, false)
}
func selectedImageMetadata(ctx context.Context, w *Workloads, id authz.Identity, wanted map[string]bool, compact bool) (map[string]imageMetadata, []string) {
	out := map[string]imageMetadata{}
	if w.Judge.MayPerform(ctx, id, listContainerImages).Verdict != authz.Yes {
		return out, []string{"ContainerImage metadata is not authorized; image labels are unavailable."}
	}
	images, err := w.Cache.Dynamic.Resource(containerImagesGVR).List(ctx, metav1.ListOptions{})
	if err != nil {
		return out, []string{"ContainerImage metadata is unavailable."}
	}
	names := map[string]string{}
	if !compact && w.Judge.MayPerform(ctx, id, authz.Attributes{Group: "codemowers.io", Resource: "sourcerepositories", Verb: "list"}).Verdict == authz.Yes {
		if sources, err := w.Cache.Dynamic.Resource(sourceRepositoriesGVR).List(ctx, metav1.ListOptions{}); err == nil {
			for _, s := range sources.Items {
				u, _, _ := unstructured.NestedString(s.Object, "spec", "url")
				names[u] = s.GetName()
			}
		}
	}
	for _, image := range images.Items {
		digests := []string{strings.Replace(image.GetName(), "sha256-", "sha256:", 1)}
		if d, _, _ := unstructured.NestedString(image.Object, "index", "digest"); d != "" {
			digests = append(digests, d)
		}
		refs, _, _ := unstructured.NestedStringSlice(image.Object, "repoDigests")
		for _, ref := range refs {
			if _, d, ok := strings.Cut(ref, "@"); ok {
				digests = append(digests, d)
			}
		}
		rawManifests, _, _ := unstructured.NestedFieldNoCopy(image.Object, "manifests")
		manifests, _ := rawManifests.([]any)
		for _, raw := range manifests {
			if m, ok := raw.(map[string]any); ok {
				if d, ok := m["digest"].(string); ok {
					digests = append(digests, d)
				}
			}
		}
		if wanted != nil {
			matched := false
			for _, d := range digests {
				if wanted[d] {
					matched = true
					break
				}
			}
			if !matched {
				continue
			}
		}
		if compact {
			for _, d := range digests {
				if wanted[d] {
					out[d] = imageMetadata{ContainerImage: image.GetName()}
				}
			}
			continue
		}
		labels := map[string]string{}
		for _, field := range []string{"annotations", "labels"} {
			values, _, _ := unstructured.NestedStringMap(image.Object, field)
			for k, v := range values {
				labels[k] = v
			}
		}
		sources := map[string]bool{}
		source, _, _ := unstructured.NestedString(image.Object, "status", "source")
		sources[source] = true
		sources[labels["org.opencontainers.image.source"]] = true
		links := []sourceLink{}
		for u := range sources {
			if httpURL(u) {
				links = append(links, sourceLink{Name: names[u], URL: u})
			}
		}
		sort.Slice(links, func(i, j int) bool { return links[i].URL < links[j].URL })
		artifacts := []string{}
		for name, value := range image.GetAnnotations() {
			if strings.HasPrefix(name, "driftmower.io/sbom-") && len(value) == 64 && strings.Trim(value, "0123456789abcdef") == "" {
				artifacts = append(artifacts, value)
			}
		}
		sort.Strings(artifacts)
		data := imageMetadata{Labels: labels, Sources: links, ContainerImage: image.GetName(), SBOMArtifacts: artifacts, Platforms: imagePlatforms(&image), ScannerNamespace: os.Getenv("POD_NAMESPACE")}

		for _, d := range digests {
			if strings.HasPrefix(d, "sha256:") && (wanted == nil || wanted[d]) {
				entry := data
				for _, p := range data.Platforms {
					if p.Digest == d {
						entry.Platforms = []registry.Target{p}
						break
					}
				}
				out[d] = entry
			}
		}
	}
	return out, nil
}

func addImageMetadataTools(s *mcp.Server, w *Workloads, mapping auth.Mapping) {
	addLocalSourceImagesTool(s, w, mapping)
	type input struct {
		Digests []string `json:"digests"`
	}
	type output struct {
		Images   map[string]imageMetadata `json:"images"`
		Warnings []string                 `json:"warnings,omitempty"`
	}
	for _, compact := range []bool{true, false} {
		name, description, maxDigests := "get_image_metadata", "Read OCI labels, source links, platform/layer metadata and SBOM references for up to 8 selected running digests. Use only when inspecting those images; not part of inventory bootstrap.", 8
		if compact {
			name = "resolve_container_images"
			description = "Resolve up to 100 running image digests to ContainerImage resource names for get_image_scan. Returns only references; no labels, layers or SBOM contents."
			maxDigests = 100
		}
		mcp.AddTool(s, &mcp.Tool{Name: name, Description: description, InputSchema: inputSchema[input](nil), Annotations: readOnly(name)}, func(ctx context.Context, req *mcp.CallToolRequest, in input) (*mcp.CallToolResult, output, error) {
			out := output{}
			if len(in.Digests) == 0 || len(in.Digests) > maxDigests {
				return nil, out, fmt.Errorf("provide between 1 and %d digests", maxDigests)
			}
			wanted := map[string]bool{}
			for _, d := range in.Digests {
				if len(d) != 71 || !strings.HasPrefix(d, "sha256:") || strings.Trim(d[7:], "0123456789abcdef") != "" {
					return nil, out, fmt.Errorf("invalid sha256 digest")
				}
				wanted[d] = true
			}
			id, err := callerIdentity(req, mapping)
			if err != nil {
				return nil, out, err
			}
			out.Images, out.Warnings = selectedImageMetadata(ctx, w, id, wanted, compact)
			return text(fmt.Sprintf("%d image digests resolved.", len(out.Images))), out, nil
		})
	}
}
