package mcpserver

import (
	"context"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// The cluster-wide Zot registry, where the platform runs one.
const (
	clusterRegistryNamespace = "registry"
	clusterRegistryService   = "zot"
)

type clusterRegistryOutput struct {
	// False when the cluster runs no zot Service in the registry namespace.
	Present bool `json:"present"`
	// The in-cluster address, zot.registry.svc.
	Service string `json:"service,omitempty"`
	// The public host of the Ingress publishing it, when there is one.
	Host string `json:"host,omitempty"`
}

func addClusterRegistryTool(s *mcp.Server, w *Workloads) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "get_cluster_registry",
		Title:       "Get cluster registry",
		Description: "Whether the cluster runs the shared Zot registry and its public host, for docker login and skaffold.env.",
		InputSchema: noArguments(),
		Annotations: readOnly("Get cluster registry"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, _ noInput) (*mcp.CallToolResult, *clusterRegistryOutput, error) {
		if err := requireCaller(req); err != nil {
			return nil, nil, err
		}
		out := &clusterRegistryOutput{}
		services, err := w.Cache.Kubernetes.CoreV1().Services(clusterRegistryNamespace).List(ctx, metav1.ListOptions{FieldSelector: "metadata.name=" + clusterRegistryService})
		if apierrors.IsNotFound(err) || (err == nil && len(services.Items) == 0) {
			return nil, out, nil
		}
		if err != nil {
			return nil, nil, err
		}
		out.Present, out.Service = true, clusterRegistryService+"."+clusterRegistryNamespace+".svc"
		ingresses, err := w.Cache.Kubernetes.NetworkingV1().Ingresses(clusterRegistryNamespace).List(ctx, metav1.ListOptions{})
		if err != nil {
			return nil, out, nil
		}
		for _, ing := range ingresses.Items {
			for _, rule := range ing.Spec.Rules {
				if rule.HTTP == nil || rule.Host == "" {
					continue
				}
				for _, path := range rule.HTTP.Paths {
					if path.Backend.Service != nil && path.Backend.Service.Name == clusterRegistryService {
						out.Host = rule.Host

						return nil, out, nil
					}
				}
			}
		}

		return nil, out, nil
	})
}
