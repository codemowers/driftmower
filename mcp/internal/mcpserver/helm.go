package mcpserver

import (
	"context"
	"fmt"
	"path"
	"sort"
	"strconv"
	"strings"

	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/workloads"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

var helmChartsGVR = schema.GroupVersionResource{Group: "helm.cattle.io", Version: "v1", Resource: "helmcharts"}
var helmSecretsGVR = schema.GroupVersionResource{Version: "v1", Resource: "secrets"}

type helmRelease struct {
	ManagementKind  string   `json:"managementKind"`
	Name            string   `json:"name"`
	Namespace       string   `json:"namespace"`
	UID             string   `json:"uid"`
	GroupKey        string   `json:"groupKey"`
	ChartName       string   `json:"chartName"`
	ChartVersion    string   `json:"chartVersion"`
	ChartAppVersion string   `json:"chartAppVersion"`
	DesiredVersion  string   `json:"desiredVersion,omitempty"`
	Revision        int      `json:"revision,omitempty"`
	SecretName      string   `json:"secretName,omitempty"`
	HelmStatus      string   `json:"helmStatus,omitempty"`
	ChartRepoURL    string   `json:"chartRepoUrl,omitempty"`
	ChartSource     string   `json:"chartSource,omitempty"`
	HelmChartRef    string   `json:"helmChartRef,omitempty"`
	Evidence        []string `json:"evidence"`
	WorkloadUIDs    []string `json:"workloadUIDs"`
}
type helmOutput struct {
	Releases []*helmRelease `json:"releases"`
	Warnings []string       `json:"warnings"`
}

func collectHelm(ctx context.Context, w *Workloads, id authz.Identity, namespace string, roots []*workloads.Workload) (helmOutput, error) {
	out := helmOutput{Releases: []*helmRelease{}, Warnings: []string{}}
	namespaces := []string{namespace}
	if namespace == "" {
		scope, err := w.Cache.Scope.Resolve(ctx, id, nil)
		if err != nil {
			return out, err
		}
		namespaces = scope.Namespaces
		if scope.Truncated || len(scope.Unknown) > 0 {
			out.Warnings = append(out.Warnings, "Helm namespace discovery is incomplete.")
		}
	}
	byKey := map[string]*helmRelease{}
	ensure := func(ns, name string) *helmRelease {
		key := "helm/" + ns + "/" + name
		r := byKey[key]
		if r == nil {
			r = &helmRelease{ManagementKind: "helm", Name: name, Namespace: ns, UID: "helm:" + ns + ":" + name, GroupKey: key, Evidence: []string{}, WorkloadUIDs: []string{}}
			byKey[key] = r
		}
		return r
	}
	_, chartErr := w.Cache.Discovery.ServerResourcesForGroupVersion("helm.cattle.io/v1")
	for _, ns := range namespaces {
		if chartErr == nil && w.Judge.MayPerform(ctx, id, authz.Attributes{Namespace: ns, Group: "helm.cattle.io", Resource: "helmcharts", Verb: "list"}).Verdict == authz.Yes {
			charts, err := w.Cache.Dynamic.Resource(helmChartsGVR).Namespace(ns).List(ctx, metav1.ListOptions{})
			if err != nil {
				out.Warnings = append(out.Warnings, ns+": HelmChart discovery unavailable.")
			} else {
				for _, chart := range charts.Items {
					target, _, _ := unstructured.NestedString(chart.Object, "spec", "targetNamespace")
					if target == "" {
						target = ns
					}
					r := ensure(target, chart.GetName())
					r.HelmChartRef = ns + "/" + chart.GetName()
					r.Evidence = append(r.Evidence, "HelmChart")
					source, _, _ := unstructured.NestedString(chart.Object, "spec", "chart")
					r.ChartSource = source
					r.ChartName = path.Base(source)
					r.DesiredVersion, _, _ = unstructured.NestedString(chart.Object, "spec", "version")
					r.ChartRepoURL, _, _ = unstructured.NestedString(chart.Object, "spec", "repo")
				}
			}
		}
		if w.Judge.MayPerform(ctx, id, authz.Attributes{Namespace: ns, Resource: "secrets", Verb: "list"}).Verdict != authz.Yes {
			out.Warnings = append(out.Warnings, ns+": Helm release Secret metadata is not authorized.")
			continue
		}
		secrets, err := w.Metadata.Resource(helmSecretsGVR).Namespace(ns).List(ctx, metav1.ListOptions{LabelSelector: "owner=helm"})
		if err != nil {
			out.Warnings = append(out.Warnings, ns+": Helm release Secret metadata unavailable.")
			continue
		}
		for _, secret := range secrets.Items {
			if secret.Labels["owner"] != "helm" || !strings.HasPrefix(secret.Name, "sh.helm.release.v1.") {
				continue
			}
			name := secret.Labels["name"]
			revision, err := strconv.Atoi(secret.Labels["version"])
			if name == "" || err != nil || revision < 1 || secret.Name != "sh.helm.release.v1."+name+".v"+strconv.Itoa(revision) {
				continue
			}
			r := ensure(ns, name)
			if revision > r.Revision {
				r.SecretName = secret.Name
				r.Revision = revision
				r.HelmStatus = secret.Labels["status"]
			}
			if !hasEvidence(r, "Secret metadata") {
				r.Evidence = append(r.Evidence, "Secret metadata")
			}
		}
	}
	conflictingVersions := map[string]bool{}
	for _, root := range roots {
		if root.HelmReleaseName == "" || root.HelmReleaseNamespace == "" {
			continue
		}
		r := byKey["helm/"+root.HelmReleaseNamespace+"/"+root.HelmReleaseName]
		if r == nil {
			continue
		}
		r.WorkloadUIDs = append(r.WorkloadUIDs, root.UID)
		// helm.sh/chart is installed-workload evidence, separate from desired spec.version.
		if i := chartVersionSeparator(root.HelmChart); i >= 0 {
			name, version := root.HelmChart[:i], root.HelmChart[i+1:]
			if conflictingVersions[r.GroupKey] {
				continue
			} else if r.ChartVersion == "" {
				r.ChartName = name
				r.ChartVersion = version
			} else if r.ChartVersion != version {
				out.Warnings = append(out.Warnings, fmt.Sprintf("%s: workloads carry differing chart versions.", r.GroupKey))
				r.ChartVersion = ""
				conflictingVersions[r.GroupKey] = true
			}
			if !hasEvidence(r, "workload metadata") {
				r.Evidence = append(r.Evidence, "workload metadata")
			}
		}
	}
	for _, r := range byKey {
		sort.Strings(r.WorkloadUIDs)
		out.Releases = append(out.Releases, r)
	}
	sort.Slice(out.Releases, func(i, j int) bool { return out.Releases[i].GroupKey < out.Releases[j].GroupKey })
	return out, nil
}
func hasEvidence(r *helmRelease, s string) bool {
	for _, v := range r.Evidence {
		if v == s {
			return true
		}
	}
	return false
}
func chartVersionSeparator(s string) int {
	for i := len(s) - 2; i >= 0; i-- {
		if s[i] == '-' && s[i+1] >= '0' && s[i+1] <= '9' && strings.Count(strings.Split(s[i+1:], "-")[0], ".") >= 2 {
			return i
		}
	}
	return -1
}
func addHelmTool(s *mcp.Server, w *Workloads, mapping auth.Mapping) {
	mcp.AddTool(s, &mcp.Tool{Name: "list_helm_releases", Title: "List Helm releases", Description: "Discover Rancher HelmChart declarations and Helm release Secret metadata. Match by release name and target namespace; attach roots with explicit Helm ownership annotations. Desired HelmChart versions are separate from installed workload chart-label evidence. Secret payloads are not requested; chart values are never returned. Revision/status are taken from the highest-numbered release Secret. Coverage gaps appear in warnings.", InputSchema: inputSchema[namespaceInput](nil), Annotations: readOnly("List Helm releases")}, func(ctx context.Context, req *mcp.CallToolRequest, in namespaceInput) (*mcp.CallToolResult, helmOutput, error) {
		id, err := callerIdentity(req, mapping)
		if err != nil {
			return nil, helmOutput{}, err
		}
		inv, err := w.Cache.List(ctx, in.Namespace, id)
		if err != nil {
			return nil, helmOutput{}, err
		}
		out, err := collectHelm(ctx, w, id, in.Namespace, inv.Workloads)
		out.Warnings = append(out.Warnings, inv.Warnings...)
		return nil, out, err
	})
}
