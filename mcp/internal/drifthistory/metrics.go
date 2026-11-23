// Package drifthistory exposes raw version observations, never monetary or
// engineering-effort estimates. The workload graph is the same one MCP reads.
package drifthistory

import (
	"context"
	"fmt"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/codemowers/driftmower/internal/crawler"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/findings"
	"github.com/codemowers/driftmower/mcp/internal/workloads"
)

type Source interface {
	Reports(context.Context) ([]crawler.SourceReport, error)
}
type Inventory interface {
	List(context.Context, string, authz.Identity) (*workloads.Inventory, error)
}

type Exporter struct {
	Source     Source
	Inventory  Inventory
	Identity   authz.Identity
	Kubernetes kubernetes.Interface
	Dynamic    dynamic.Interface
}

func (e *Exporter) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	reports, err := e.Source.Reports(ctx)
	if err != nil {
		http.Error(w, "crawler unavailable", http.StatusServiceUnavailable)
		return
	}
	inventory, err := e.Inventory.List(ctx, "", e.Identity)
	if err != nil {
		http.Error(w, "inventory unavailable", http.StatusServiceUnavailable)
		return
	}
	// An incomplete inventory must not record missing workloads as deleted.
	if len(inventory.Warnings) != 0 {
		http.Error(w, "inventory incomplete", http.StatusServiceUnavailable)
		return
	}
	counts := map[string]int{}
	if e.Kubernetes != nil {
		inventory, counts, err = e.running(ctx, inventory)
		if err != nil {
			http.Error(w, "running images unavailable", http.StatusServiceUnavailable)
			return
		}
	}
	created := map[string]int64{}
	if e.Dynamic != nil {
		images, err := e.Dynamic.Resource(schema.GroupVersionResource{Group: "codemowers.io", Version: "v1alpha1", Resource: "containerimages"}).List(ctx, metav1.ListOptions{})
		if err != nil {
			http.Error(w, "image metadata unavailable", http.StatusServiceUnavailable)
			return
		}
		created = imageCreatedIndex(images.Items)
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	_, _ = w.Write([]byte(render(inventory, reports, counts, created)))
}

// Render is deterministic and includes unknown coverage explicitly. No pod names
// or ephemeral container IDs enter labels; cardinality follows root/image pairs.
func Render(inv *workloads.Inventory, reports []crawler.SourceReport) string {
	return render(inv, reports, nil)
}

func render(inv *workloads.Inventory, reports []crawler.SourceReport, counts map[string]int, createdMaps ...map[string]int64) string {
	index := findings.NewIndex(reports)
	var out strings.Builder
	out.WriteString("# HELP driftmower_version_releases_behind Number of newer stable releases; absent when comparison is unknown.\n# TYPE driftmower_version_releases_behind gauge\n")
	out.WriteString("# HELP driftmower_version_checked_timestamp_seconds Last source crawl Unix timestamp; absent when never crawled.\n# TYPE driftmower_version_checked_timestamp_seconds gauge\n")
	out.WriteString("# HELP driftmower_version_container_count Observed containers running this workload image.\n# TYPE driftmower_version_container_count gauge\n")
	out.WriteString("# HELP driftmower_version_status Comparison state with bounded reason labels.\n# TYPE driftmower_version_status gauge\n")
	out.WriteString("# HELP driftmower_version_drift Semantic distance to the newest release: current, patch, minor, major or behind when the newest release does not parse.\n# TYPE driftmower_version_drift gauge\n")
	out.WriteString("# HELP driftmower_image_created_timestamp_seconds Unix timestamp from org.opencontainers.image.created only.\n# TYPE driftmower_image_created_timestamp_seconds gauge\n")
	for _, wl := range inv.Workloads {
		if wl.Kind == "Namespace" {
			continue
		}
		for _, image := range wl.Images {
			version, source, latest := "", "", ""
			behind, checked := -1, int64(0)
			reason := "no_source_match"
			if match, ok := index.Lookup(image); ok {
				version, source, behind = match.Version.Version, match.Source.URL, match.Version.Behind
				reason = "known"
				if behind < 0 {
					reason = "no_comparable_release"
					if _, ok := crawler.ParseVersion(version); !ok {
						reason = "unrecognized_version"
					}
				}
				if match.Source.Latest != nil {
					latest = match.Source.Latest.Tag
				}
				if !match.Source.CheckedAt.IsZero() {
					checked = match.Source.CheckedAt.Unix()
				}
				if len(match.Source.Errors) > 0 || checked == 0 {
					behind = -1
					reason = "crawl_error"
					if checked == 0 {
						reason = "not_crawled"
					}
				}
			}
			labels := fmt.Sprintf("namespace=%s,kind=%s,workload=%s,uid=%s,image=%s,source=%s,version=%s,latest=%s", quote(wl.Namespace), quote(wl.Kind), quote(wl.Name), quote(wl.UID), quote(image), quote(source), quote(version), quote(latest))
			state := "unknown"
			if reason == "known" {
				state = "known"
				fmt.Fprintf(&out, "driftmower_version_releases_behind{%s} %d\n", labels, behind)
				fmt.Fprintf(&out, "driftmower_version_drift{%s,class=%s} 1\n", labels, quote(driftClass(version, latest, behind)))
			}
			fmt.Fprintf(&out, "driftmower_version_status{%s,status=%s,reason=%s} 1\n", labels, quote(state), quote(reason))
			if checked > 0 {
				fmt.Fprintf(&out, "driftmower_version_checked_timestamp_seconds{%s} %d\n", labels, checked)
			}
			if len(createdMaps) > 0 {
				if timestamp, ok := createdMaps[0][imageDigest(image)]; ok {
					fmt.Fprintf(&out, "driftmower_image_created_timestamp_seconds{%s} %d\n", labels, timestamp)
				}
			}
			if counts != nil {
				fmt.Fprintf(&out, "driftmower_version_container_count{%s} %d\n", labels, counts[wl.UID+"|"+image])
			}
		}
	}
	return out.String()
}

func quote(s string) string { return strconv.Quote(s) }

// Attribute actual running digests to the shared Go ownership graph. Tag
// observations alone cannot identify an old image behind a mutable tag.
func (e *Exporter) running(ctx context.Context, inv *workloads.Inventory) (*workloads.Inventory, map[string]int, error) {
	counts := map[string]int{}
	roots := map[string]*workloads.Workload{}
	namespaces := map[string]bool{}
	out := &workloads.Inventory{}
	for _, wl := range inv.Workloads {
		namespaces[wl.Namespace] = true
		if wl.Kind == "Namespace" {
			continue
		}
		copy := *wl
		copy.Dependencies = workloads.Dependencies{}
		out.Workloads = append(out.Workloads, &copy)
		for _, pod := range wl.Pods {
			roots[wl.Namespace+"/"+pod] = &copy
		}
	}
	for ns := range namespaces {
		pods, err := e.Kubernetes.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return nil, nil, err
		}
		for _, pod := range pods.Items {
			if pod.Status.Phase == "Succeeded" || pod.Status.Phase == "Failed" {
				continue
			}
			root := roots[ns+"/"+pod.Name]
			if root == nil {
				root = &workloads.Workload{Kind: "Pod", Namespace: ns, Name: pod.Name, UID: string(pod.UID)}
				out.Workloads = append(out.Workloads, root)
			}
			statuses := map[string]string{}
			for _, status := range pod.Status.ContainerStatuses {
				statuses[status.Name] = status.ImageID
			}
			for _, container := range pod.Spec.Containers {
				ref := container.Image
				runtime := strings.TrimPrefix(strings.TrimPrefix(statuses[container.Name], "docker-pullable://"), "containerd://")
				if _, digest, ok := strings.Cut(runtime, "@"); ok {
					runtime = digest
				}
				if strings.HasPrefix(runtime, "sha256:") {
					keys := findings.Keys(ref)
					if len(keys) > 0 {
						name := strings.Split(keys[0], "@")[0]
						if colon := strings.LastIndex(name, ":"); colon > strings.LastIndex(name, "/") {
							name = name[:colon]
						}
						ref = name + "@" + runtime
					}
				}
				key := root.UID + "|" + ref
				if counts[key] == 0 {
					root.Images = append(root.Images, ref)
				}
				counts[key]++
			}
		}
	}
	sort.Slice(out.Workloads, func(i, j int) bool { return out.Workloads[i].UID < out.Workloads[j].UID })
	for _, wl := range out.Workloads {
		sort.Strings(wl.Images)
	}
	return out, counts, nil
}

func imageDigest(ref string) string {
	if _, digest, ok := strings.Cut(ref, "@"); ok {
		return digest
	}
	if strings.HasPrefix(ref, "sha256:") {
		return ref
	}
	return ""
}

// OCI annotations and config labels share the same standardized key. Never
// substitute config.created, CRD creation time, or a filesystem timestamp.
func imageCreatedIndex(images []unstructured.Unstructured) map[string]int64 {
	out := map[string]int64{}
	for _, image := range images {
		raw, _, _ := unstructured.NestedString(image.Object, "labels", "org.opencontainers.image.created")
		if raw == "" {
			raw, _, _ = unstructured.NestedString(image.Object, "annotations", "org.opencontainers.image.created")
		}
		created, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			continue
		}
		digests := []string{strings.Replace(image.GetName(), "sha256-", "sha256:", 1)}
		index, _, _ := unstructured.NestedString(image.Object, "index", "digest")
		digests = append(digests, index)
		refs, _, _ := unstructured.NestedStringSlice(image.Object, "repoDigests")
		for _, ref := range refs {
			digests = append(digests, imageDigest(ref))
		}
		manifests, _, _ := unstructured.NestedSlice(image.Object, "manifests")
		for _, item := range manifests {
			if manifest, ok := item.(map[string]any); ok {
				if digest, ok := manifest["digest"].(string); ok {
					digests = append(digests, digest)
				}
			}
		}
		for _, digest := range digests {
			if strings.HasPrefix(digest, "sha256:") {
				out[digest] = created.Unix()
			}
		}
	}
	return out
}

// driftClass compares the deployed and newest versions by semantic component.
func driftClass(version, latest string, behind int) string {
	if behind == 0 {
		return "current"
	}
	v, ok := crawler.ParseVersion(version)
	l, ok2 := crawler.ParseVersion(latest)
	if !ok || !ok2 {
		return "behind"
	}
	at := func(c []int, i int) int {
		if i < len(c) {
			return c[i]
		}
		return 0
	}
	switch {
	case at(l.Core, 0) != at(v.Core, 0):
		return "major"
	case at(l.Core, 1) != at(v.Core, 1):
		return "minor"
	default:
		return "patch"
	}
}
