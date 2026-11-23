package mcpserver

import (
	"context"
	"fmt"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/cluster"
)

type noInput struct{}

type clusterIdentityOutput struct {
	Cluster               cluster.Identity `json:"cluster"`
	ContextSelection      string           `json:"contextSelection"`
	DiscoveryInstructions string           `json:"discoveryInstructions"`
}

func addClusterIdentityTool(s *mcp.Server, c cluster.Identity, usage string) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "get_cluster_identity",
		Title:       "Identify this cluster",
		InputSchema: noArguments(),
		Description: "Cluster ID and external Kubernetes API URL. Match the URL against local kubeconfig before choosing a kubectl context.",
		Annotations: readOnly("Identify this cluster"),
	}, func(context.Context, *mcp.CallToolRequest, noInput) (*mcp.CallToolResult, clusterIdentityOutput, error) {
		return nil, clusterIdentityOutput{
			Cluster:               c,
			ContextSelection:      cluster.Instructions(c),
			DiscoveryInstructions: usage,
		}, nil
	})
}

type accessibleNamespacesOutput struct {
	Namespaces  []string       `json:"namespaces"`
	ClusterWide bool           `json:"clusterWide"`
	Unknown     []string       `json:"unknown"`
	Truncated   bool           `json:"truncated"`
	Identity    authz.Identity `json:"identity"`
	Note        string         `json:"note,omitempty"`
}

func addAccessibleNamespacesTool(s *mcp.Server, resolver *authz.ScopeResolver, m auth.Mapping) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "list_accessible_namespaces",
		Title:       "List accessible namespaces",
		InputSchema: noArguments(),
		Description: "Namespaces where the caller may list pods. Check unknown and truncated before treating it as complete.",
		Annotations: readOnly("List accessible namespaces"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, _ noInput) (*mcp.CallToolResult, accessibleNamespacesOutput, error) {
		id, err := callerIdentity(req, m)
		if err != nil {
			return nil, accessibleNamespacesOutput{}, fmt.Errorf("namespace discovery requires an authenticated caller: %w", err)
		}
		scope, err := resolver.Resolve(ctx, id, nil)
		if err != nil {
			return nil, accessibleNamespacesOutput{}, err
		}

		return nil, accessibleNamespacesOutput{
			Namespaces:  scope.Namespaces,
			ClusterWide: scope.ClusterWide,
			Unknown:     scope.Unknown,
			Truncated:   scope.Truncated,
			Identity:    id,
			Note:        scopeNote(scope, id),
		}, nil
	})
}

func scopeNote(scope authz.RBACScope, id authz.Identity) string {
	var notes []string
	if scope.ClusterWide {
		notes = append(notes, "The caller may list pods in every namespace, so all namespaces are listed.")
	}
	if len(scope.Unknown) > 0 {
		notes = append(notes, fmt.Sprintf("Access to %d namespace(s) could not be evaluated by the cluster authorizer; they are excluded, not denied.", len(scope.Unknown)))
	}
	if scope.Truncated {
		notes = append(notes, fmt.Sprintf("The cluster has %d namespaces and only a bounded set was checked; name namespaces explicitly or raise MCP_SCOPE_MAX_NAMESPACES.", scope.Total))
	}
	if !scope.ClusterWide && len(scope.Namespaces) == 0 && len(scope.Unknown) == 0 {
		notes = append(notes, "Kubernetes RBAC grants "+auth.Describe(id)+" list-pods access in no namespace. "+
			"If that is unexpected, check KUBERNETES_USERNAME_CLAIM and KUBERNETES_USERNAME_PREFIX against the apiserver's OIDC mapping.")
	}

	return strings.Join(notes, " ")
}
