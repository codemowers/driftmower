package mcpserver

import (
	"context"
	"net/url"
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
	Labels         map[string]string
	Sources        []sourceLink
	ContainerImage string
	SBOMArtifacts  []string
}

func httpURL(raw string) bool {
	u, e := url.Parse(raw)
	return e == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" && u.User == nil
}
func imageMetadataIndex(ctx context.Context, w *Workloads, id authz.Identity) (map[string]imageMetadata, []string) {
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
	for _, image := range images.Items {
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
		data := imageMetadata{Labels: labels, Sources: links, ContainerImage: image.GetName(), SBOMArtifacts: artifacts}
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
		manifests, _, _ := unstructured.NestedSlice(image.Object, "manifests")
		for _, raw := range manifests {
			if m, ok := raw.(map[string]any); ok {
				if d, ok := m["digest"].(string); ok {
					digests = append(digests, d)
				}
			}
		}
		for _, d := range digests {
			if strings.HasPrefix(d, "sha256:") {
				out[d] = data
			}
		}
	}
	return out, nil
}
