package mcpserver

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/findings"
	"github.com/codemowers/driftmower/mcp/internal/kube"
	"github.com/codemowers/driftmower/mcp/internal/workloads"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

type sourceImage struct{ digests, tags, urls []string }

func workloadSources(ctx context.Context, w *Workloads, id authz.Identity, roots []*workloads.Workload) ([]*workloads.Workload, []string, error) {
	if len(roots) == 0 {
		return roots, nil, nil
	}
	if w.Judge.MayPerform(ctx, id, listContainerImages).Verdict != authz.Yes {
		return roots, []string{"Source links unavailable: listing ContainerImages is not authorized."}, nil
	}
	images, err := kube.Collect(ctx, func(ctx context.Context, opts metav1.ListOptions) ([]sourceImage, string, error) {
		page, err := w.Cache.Dynamic.Resource(containerImagesGVR).List(ctx, opts)
		if err != nil {
			return nil, "", err
		}
		rows := []sourceImage{}
		for _, image := range page.Items {
			row := sourceImage{digests: []string{strings.Replace(image.GetName(), "sha256-", "sha256:", 1)}}
			row.tags, _, _ = unstructured.NestedStringSlice(image.Object, "repoTags")
			refs, _, _ := unstructured.NestedStringSlice(image.Object, "repoDigests")
			for _, ref := range refs {
				if _, d, ok := strings.Cut(ref, "@"); ok {
					row.digests = append(row.digests, d)
				}
			}
			if d, _, _ := unstructured.NestedString(image.Object, "index", "digest"); d != "" {
				row.digests = append(row.digests, d)
			}
			raw, _, _ := unstructured.NestedFieldNoCopy(image.Object, "manifests")
			manifests, _ := raw.([]any)
			for _, raw := range manifests {
				if m, ok := raw.(map[string]any); ok {
					if d, ok := m["digest"].(string); ok {
						row.digests = append(row.digests, d)
					}
				}
			}
			for _, path := range [][]string{{"status", "source"}, {"labels", "org.opencontainers.image.source"}, {"annotations", "org.opencontainers.image.source"}} {
				if u, _, _ := unstructured.NestedString(image.Object, path...); httpURL(u) && !slices.Contains(row.urls, u) {
					row.urls = append(row.urls, u)
				}
			}
			if len(row.urls) > 0 {
				rows = append(rows, row)
			}
		}
		return rows, page.GetContinue(), nil
	}, kube.ListOptions{Limit: 100, MaxPages: 100, What: "image source links"})
	if err != nil {
		return nil, nil, err
	}
	names := map[string]string{}
	warnings := []string{}
	if w.Judge.MayPerform(ctx, id, authz.Attributes{Group: "codemowers.io", Resource: "sourcerepositories", Verb: "list"}).Verdict == authz.Yes {
		refs, err := kube.Collect(ctx, func(ctx context.Context, opts metav1.ListOptions) ([]workloads.SourceRepository, string, error) {
			page, err := w.Cache.Dynamic.Resource(sourceRepositoriesGVR).List(ctx, opts)
			if err != nil {
				return nil, "", err
			}
			rows := []workloads.SourceRepository{}
			for _, source := range page.Items {
				u, _, _ := unstructured.NestedString(source.Object, "spec", "url")
				rows = append(rows, workloads.SourceRepository{Name: source.GetName(), URL: u})
			}
			return rows, page.GetContinue(), nil
		}, kube.ListOptions{Limit: 100, MaxPages: 100, What: "source repositories"})
		if err != nil {
			warnings = append(warnings, "SourceRepository resource names are unavailable.")
		} else {
			for _, r := range refs {
				names[r.URL] = r.Name
			}
		}
	}
	out := make([]*workloads.Workload, 0, len(roots))
	podsByNamespace := map[string][]workloads.PodSnapshot{}
	for _, root := range roots {
		copyRoot := *root
		copyRoot.SourceRepositories = nil
		pods, known := podsByNamespace[root.Namespace]
		if !known {
			var podWarnings []string
			pods, podWarnings, err = w.Cache.Pods(ctx, root.Namespace, id)
			if err != nil {
				return nil, nil, err
			}
			podsByNamespace[root.Namespace] = pods
			warnings = append(warnings, podWarnings...)
		}
		type target struct{ image, digest string }
		targets := []target{}
		for _, pod := range pods {
			if !slices.Contains(root.Pods, pod.Name) {
				continue
			}
			for _, container := range pod.Containers {
				running := strings.TrimPrefix(strings.TrimPrefix(container.ImageID, "docker-pullable://"), "containerd://")
				digest := ""
				if _, d, ok := strings.Cut(running, "@"); ok {
					digest = d
				} else if strings.HasPrefix(running, "sha256:") {
					digest = running
				}
				if digest == "" {
					_, digest, _ = strings.Cut(container.Image, "@")
				}
				targets = append(targets, target{container.Image, digest})
			}
		}
		if len(targets) == 0 {
			for _, image := range root.Images {
				_, d, _ := strings.Cut(image, "@")
				targets = append(targets, target{image, d})
			}
		}
		byURL := map[string]*workloads.SourceRepository{}
		for _, target := range targets {
			for _, image := range images {
				matched := target.digest != "" && slices.Contains(image.digests, target.digest)
				if target.digest == "" {
					for _, tag := range image.tags {
						if slices.ContainsFunc(findings.Keys(tag), func(key string) bool { return slices.Contains(findings.Keys(target.image), key) }) {
							matched = true
							break
						}
					}
				}
				if !matched {
					continue
				}
				for _, url := range image.urls {
					r := byURL[url]
					if r == nil {
						r = &workloads.SourceRepository{Name: names[url], URL: url}
						byURL[url] = r
					}
					if !slices.Contains(r.Images, target.image) {
						r.Images = append(r.Images, target.image)
					}
				}
			}
		}
		for _, r := range byURL {
			slices.Sort(r.Images)
			copyRoot.SourceRepositories = append(copyRoot.SourceRepositories, *r)
		}
		slices.SortFunc(copyRoot.SourceRepositories, func(a, b workloads.SourceRepository) int { return strings.Compare(a.URL, b.URL) })
		out = append(out, &copyRoot)
	}
	slices.Sort(warnings)
	return out, slices.Compact(warnings), nil
}

func addWorkloadSourcesTool(s *mcp.Server, w *Workloads, mapping auth.Mapping) {
	type input struct {
		Namespace string `json:"namespace"`
		UID       string `json:"uid"`
	}
	type output struct {
		Sources  []workloads.SourceRepository `json:"sources"`
		Warnings []string                     `json:"warnings,omitempty"`
	}
	mcp.AddTool(s, &mcp.Tool{Name: "get_workload_sources", Description: "Resolve one authorized workload's images to SourceRepository names and URLs. Running immutable digests take priority over moving tags. No image layers or crawler payloads; read scrape status from the source crawler's get_source_findings tool using each URL.", InputSchema: inputSchema[input](nil), Annotations: readOnly("Workload source repositories")}, func(ctx context.Context, req *mcp.CallToolRequest, in input) (*mcp.CallToolResult, output, error) {
		out := output{Sources: []workloads.SourceRepository{}}
		if in.Namespace == "" || in.UID == "" {
			return nil, out, fmt.Errorf("namespace and workload UID are required")
		}
		id, err := callerIdentity(req, mapping)
		if err != nil {
			return nil, out, err
		}
		inv, err := w.Cache.List(ctx, in.Namespace, id)
		if err != nil {
			return nil, out, err
		}
		i := slices.IndexFunc(inv.Workloads, func(root *workloads.Workload) bool { return root.UID == in.UID })
		if i < 0 {
			return nil, out, fmt.Errorf("workload unavailable or not authorized")
		}
		roots, warnings, err := workloadSources(ctx, w, id, inv.Workloads[i:i+1])
		if err != nil {
			return nil, out, err
		}
		out.Sources = roots[0].SourceRepositories
		if out.Sources == nil {
			out.Sources = []workloads.SourceRepository{}
		}
		out.Warnings = append(inv.Warnings, warnings...)
		return text(fmt.Sprintf("%d source repositories.", len(out.Sources))), out, nil
	})
}
