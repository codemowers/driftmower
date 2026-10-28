package workloads

import (
	"context"
	"errors"
	"slices"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/metadata"

	"github.com/codemowers/driftmower-mcp/internal/authz"
	"github.com/codemowers/driftmower-mcp/internal/kube"
)

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
