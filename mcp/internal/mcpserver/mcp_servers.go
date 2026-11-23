package mcpserver

import (
	"context"
	"slices"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
)

const mcpServersGroup = "codemowers.ai"

var (
	clusterMCPServersGVR = schema.GroupVersionResource{Group: mcpServersGroup, Version: "v1alpha1", Resource: "clustermcpservers"}
	mcpServersGVR        = schema.GroupVersionResource{Group: mcpServersGroup, Version: "v1alpha1", Resource: "mcpservers"}
)

type mcpServer struct {
	Name string `json:"name"`
	// Empty for a ClusterMCPServer.
	Namespace   string `json:"namespace,omitempty"`
	URL         string `json:"url"`
	Audience    string `json:"audience,omitempty"`
	Description string `json:"description,omitempty"`
}

type mcpServersOutput struct {
	Servers  []mcpServer `json:"servers"`
	Warnings []string    `json:"warnings"`
}

// addMCPServersTool lists the MCP servers registered as ClusterMCPServer and
// MCPServer resources, as far as the caller may list them.
func addMCPServersTool(s *mcp.Server, w *Workloads, mapping auth.Mapping) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "list_mcp_servers",
		Title:       "List MCP servers",
		Description: "Registered ClusterMCPServers and MCPServers with description, URL and token audience.",
		InputSchema: noArguments(),
		Annotations: readOnly("List MCP servers"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, _ noInput) (*mcp.CallToolResult, *mcpServersOutput, error) {
		id, err := callerIdentity(req, mapping)
		if err != nil {
			return nil, nil, err
		}
		out := &mcpServersOutput{Servers: []mcpServer{}, Warnings: []string{}}
		if _, err := w.Cache.Discovery.ServerResourcesForGroupVersion(mcpServersGroup + "/v1alpha1"); err != nil {
			return nil, out, nil
		}
		if w.Judge.MayPerform(ctx, id, authz.Attributes{Group: mcpServersGroup, Resource: "clustermcpservers", Verb: "list"}).Verdict == authz.Yes {
			if list, err := w.Cache.Dynamic.Resource(clusterMCPServersGVR).List(ctx, metav1.ListOptions{}); err == nil {
				for _, item := range list.Items {
					out.Servers = append(out.Servers, toMCPServer(item))
				}
			} else {
				out.Warnings = append(out.Warnings, "ClusterMCPServers could not be listed")
			}
		}
		scope, err := w.Cache.Scope.Resolve(ctx, id, nil)
		if err != nil {
			return nil, nil, err
		}
		allowed := map[string]bool{}
		for _, ns := range scope.Namespaces {
			if w.Judge.MayPerform(ctx, id, authz.Attributes{Namespace: ns, Group: mcpServersGroup, Resource: "mcpservers", Verb: "list"}).Verdict == authz.Yes {
				allowed[ns] = true
			}
		}
		if len(allowed) > 0 {
			if list, err := w.Cache.Dynamic.Resource(mcpServersGVR).List(ctx, metav1.ListOptions{}); err == nil {
				for _, item := range list.Items {
					if allowed[item.GetNamespace()] {
						out.Servers = append(out.Servers, toMCPServer(item))
					}
				}
			} else {
				out.Warnings = append(out.Warnings, "MCPServers could not be listed")
			}
		}
		slices.SortFunc(out.Servers, func(a, b mcpServer) int {
			return strings.Compare(a.Namespace+"/"+a.Name, b.Namespace+"/"+b.Name)
		})

		return nil, out, nil
	})
}

func toMCPServer(u unstructured.Unstructured) mcpServer {
	url, _, _ := unstructured.NestedString(u.Object, "spec", "url")
	audience, _, _ := unstructured.NestedString(u.Object, "spec", "audience")

	return mcpServer{Name: u.GetName(), Namespace: u.GetNamespace(), URL: url, Audience: audience, Description: u.GetAnnotations()["kubernetes.io/description"]}
}
