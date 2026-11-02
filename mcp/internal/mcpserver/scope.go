package mcpserver

import (
	"context"
	"log/slog"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/codemowers/driftmower-mcp/internal/auth"
	"github.com/codemowers/driftmower-mcp/internal/authz"
	"github.com/codemowers/driftmower-mcp/internal/tenancy"
)

// Tenancy decides which namespaces driftmower-be results are confined to.
type Tenancy struct {
	Policy   tenancy.Policy
	Resolver *authz.ScopeResolver
	Mapping  auth.Mapping
	Logger   *slog.Logger
}

// resolveScope derives the caller's scope from the verified token, never
// from tool arguments. Without a verified caller (stdio, or authentication
// off) the operator has already decided the process is trusted, so the scope
// is unrestricted. Otherwise the configured sources decide: the claim alone,
// the authorizer alone, or their union.
func (t *Tenancy) resolveScope(ctx context.Context, req *mcp.CallToolRequest) tenancy.Scope {
	caller := auth.CallerFrom(req.Extra.TokenInfo)
	if caller == nil {
		return tenancy.UnrestrictedScope
	}
	if t.Policy == tenancy.PolicyClaim || t.Resolver == nil {
		return tenancy.FromClaimOnly(caller.Namespaces)
	}
	id, err := auth.KubernetesIdentity(caller, t.Mapping)
	if err != nil {
		return tenancy.Merge(caller.Namespaces, authz.RBACScope{}, err, t.Policy, "")
	}
	rbac, err := t.Resolver.Resolve(ctx, id, caller.Namespaces.Namespaces)
	if err != nil {
		t.Logger.Info("scope", "sub", caller.Sub, "user", id.User, "error", err)
	} else {
		t.Logger.Info("scope", "sub", caller.Sub, "user", id.User, "namespaces", len(rbac.Namespaces), "clusterWide", rbac.ClusterWide,
			"unknown", len(rbac.Unknown), "truncated", rbac.Truncated, "policy", t.Policy)
	}

	return tenancy.Merge(caller.Namespaces, rbac, err, t.Policy, auth.Describe(id))
}
