package workloads

import (
	"context"
	"errors"
	"github.com/codemowers/driftmower/mcp/internal/kube"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/metadata"
	"slices"
	"strings"

	"github.com/codemowers/driftmower/mcp/internal/authz"
	"k8s.io/client-go/tools/cache"
)

// Pods reads already-reduced watch data. Listing a page never rereads full Pod
// specs from the API, and each namespace remains gated by the caller's access.
func (c *Cache) Pods(ctx context.Context, namespace string, id authz.Identity) ([]PodSnapshot, []string, error) {
	if c.ctx == nil || c.ctx.Err() != nil {
		return nil, nil, errors.New("workload cache is stopped")
	}
	namespaces := []string{namespace}
	warnings := []string{}
	if namespace == "" {
		scope, err := c.Scope.Resolve(ctx, id, nil)
		if err != nil {
			return nil, nil, err
		}
		namespaces = scope.Namespaces
		if scope.Truncated || len(scope.Unknown) > 0 {
			warnings = append(warnings, "Pod namespace coverage is incomplete.")
		}
	}
	c.initialize()
	out := []PodSnapshot{}
	for _, ns := range namespaces {
		if c.Judge.MayPerform(ctx, id, authz.Attributes{Namespace: ns, Resource: "pods", Verb: "list"}).Verdict != authz.Yes {
			warnings = append(warnings, ns+": list pods is not authorized.")
			continue
		}
		for _, target := range c.targets {
			if target.source.Kind != "Pod" {
				continue
			}
			if warning := target.getWarning(); warning != "" {
				warnings = append(warnings, ns+": "+warning)
			}
			if target.informer == nil {
				warnings = append(warnings, ns+": Pod inventory is not watched.")
				continue
			}
			items, err := target.informer.GetIndexer().ByIndex(cache.NamespaceIndex, ns)
			if err != nil {
				return nil, nil, err
			}
			for _, raw := range items {
				if node, ok := raw.(*Node); ok && node.Pod != nil {
					out = append(out, *node.Pod)
				}
			}
		}
	}
	slices.SortFunc(out, func(a, b PodSnapshot) int {
		if v := strings.Compare(a.Namespace, b.Namespace); v != 0 {
			return v
		}
		if v := strings.Compare(a.Name, b.Name); v != 0 {
			return v
		}
		return strings.Compare(a.UID, b.UID)
	})
	return out, warnings, nil
}

// CurrentRevision is cheap and does not start discovery or watches.
func (c *Cache) CurrentRevision() string { return c.version() }

// ListPodNames returns the sorted pod names in a namespace, reading metadata
// only, after checking the caller may list pods there. An incomplete listing
// is an error.
func ListPodNames(ctx context.Context, client metadata.Interface, judge authz.Judge, id authz.Identity, namespace string) ([]string, error) {
	j := judge.MayPerform(ctx, id, authz.Attributes{Namespace: namespace, Resource: "pods", Verb: "list"})
	switch j.Verdict {
	case authz.No:
		return nil, errors.New("Kubernetes RBAC denied list pods in namespace " + namespace) //nolint:staticcheck // Kubernetes is a proper noun.
	case authz.Unknown:
		return nil, errors.New(j.Reason)
	}

	names, err := kube.Collect(ctx, func(ctx context.Context, opts metav1.ListOptions) ([]string, string, error) {
		list, err := client.Resource(podsGVR).Namespace(namespace).List(ctx, opts)
		if err != nil {
			return nil, "", err
		}
		out := make([]string, len(list.Items))
		for i, p := range list.Items {
			out[i] = p.Name
		}

		return out, list.Continue, nil
	}, kube.ListOptions{Limit: 200, MaxPages: 20, What: "Pod listing"})
	if err != nil {
		return nil, err
	}
	slices.Sort(names)

	return slices.Compact(names), nil
}
