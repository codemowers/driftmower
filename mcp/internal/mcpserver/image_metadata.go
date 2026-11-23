package mcpserver

import (
	"context"
	"fmt"
	"github.com/codemowers/driftmower/internal/imagesource"
	"github.com/codemowers/driftmower/internal/registry"
	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

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
	ConfigCreated  string            `json:"configCreated,omitempty"`
	Labels         map[string]string `json:"labels,omitempty"`
	Sources        []sourceLink      `json:"sourceRepositories,omitempty"`
	ContainerImage string            `json:"containerImage"`
	// InheritedSource explains why the image's source metadata was
	// discarded as inherited from a base image.
	InheritedSource  string            `json:"inheritedSource,omitempty"`
	SBOMArtifacts    []string          `json:"sbomArtifacts,omitempty"`
	Platforms        []registry.Target `json:"platforms,omitempty"`
	ScannerNamespace string            `json:"scannerNamespace,omitempty"`
}

func httpURL(raw string) bool {
	u, e := url.Parse(raw)
	return e == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" && u.User == nil
}
func selectedImageMetadata(ctx context.Context, w *Workloads, id authz.Identity, wanted map[string]bool) (map[string]imageMetadata, []string) {
	out := map[string]imageMetadata{}
	if w.Judge.MayPerform(ctx, id, listContainerImages).Verdict != authz.Yes {
		return out, []string{"ContainerImage metadata is not authorized; image labels are unavailable."}
	}
	images, err := w.Cache.Dynamic.Resource(containerImagesGVR).List(ctx, metav1.ListOptions{})
	if err != nil {
		return out, []string{"ContainerImage metadata is unavailable."}
	}
	names := map[string]string{}
	if w.Judge.MayPerform(ctx, id, authz.Attributes{Group: "codemowers.io", Resource: "sourcerepositories", Verb: "list"}).Verdict == authz.Yes {
		if sources, err := w.Cache.Dynamic.Resource(sourceRepositoriesGVR).List(ctx, metav1.ListOptions{}); err == nil {
			for _, s := range sources.Items {
				u, _, _ := unstructured.NestedString(s.Object, "spec", "url")
				names[u] = s.GetName()
			}
		}
	}
	objects := make([]map[string]any, len(images.Items))
	for i := range images.Items {
		objects[i] = images.Items[i].Object
	}
	index := imagesource.NewIndex(objects)
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
		labels := map[string]string{}
		for _, field := range []string{"annotations", "labels"} {
			values, _, _ := unstructured.NestedStringMap(image.Object, field)
			for k, v := range values {
				labels[k] = v
			}
		}
		// Only the image's own source claim links it; metadata copied from a
		// base image is unknown provenance and explained instead.
		claim := imagesource.Of(image.Object, index)
		links := []sourceLink{}
		if httpURL(claim.Source) {
			links = append(links, sourceLink{Name: names[claim.Source], URL: claim.Source})
		}
		artifacts := []string{}
		for name, value := range image.GetAnnotations() {
			if strings.HasPrefix(name, "driftmower.io/sbom-") && len(value) == 64 && strings.Trim(value, "0123456789abcdef") == "" {
				artifacts = append(artifacts, value)
			}
		}
		sort.Strings(artifacts)
		data := imageMetadata{Labels: labels, Sources: links, InheritedSource: claim.Inherited, ContainerImage: image.GetName(), SBOMArtifacts: artifacts, Platforms: imagePlatforms(&image), ScannerNamespace: os.Getenv("POD_NAMESPACE")}

		for _, d := range digests {
			if strings.HasPrefix(d, "sha256:") && (wanted == nil || wanted[d]) {
				entry := data
				entry.ConfigCreated = imageConfigCreated(&image, d)
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

// Config creation is a declared build fact even when an image has no OCI
// created label. An index uses its oldest available platform, matching the
// image detail's conservative config-time selection.
func imageConfigCreated(image *unstructured.Unstructured, digest string) string {
	fallback, _, _ := unstructured.NestedString(image.Object, "created")
	manifests, _, _ := unstructured.NestedSlice(image.Object, "manifests")
	oldest := ""
	var oldestTime time.Time
	for _, raw := range manifests {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		created, _ := m["created"].(string)
		if m["digest"] == digest {
			if created != "" {
				return created
			}
			return fallback
		}
		parsed, err := time.Parse(time.RFC3339Nano, created)
		if err == nil && (oldest == "" || parsed.Before(oldestTime)) {
			oldest, oldestTime = created, parsed
		}
	}
	if fallback != "" {
		return fallback
	}
	return oldest
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
	mcp.AddTool(s, &mcp.Tool{Name: "get_image_metadata", Description: "OCI labels, source links, platforms, layers and SBOM references for running image digests.", InputSchema: inputSchema[input](nil), Annotations: readOnly("Read image metadata")}, func(ctx context.Context, req *mcp.CallToolRequest, in input) (*mcp.CallToolResult, output, error) {
		out := output{}
		if len(in.Digests) == 0 {
			return nil, out, fmt.Errorf("provide at least one digest")
		}
		wanted := map[string]bool{}
		for _, d := range in.Digests {
			if !validDigest(d) {
				return nil, out, fmt.Errorf("invalid sha256 digest")
			}
			wanted[d] = true
		}
		id, err := callerIdentity(req, mapping)
		if err != nil {
			return nil, out, err
		}
		out.Images, out.Warnings = selectedImageMetadata(ctx, w, id, wanted)
		return text(fmt.Sprintf("%d image digests resolved.", len(out.Images))), out, nil
	})
}
