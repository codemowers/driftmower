package mcpserver

import (
	"context"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/useraccess"
)

type oidcUsersOutput struct {
	Users []useraccess.User `json:"users"`
}

type oidcUserAccessInput struct {
	Name    string `json:"name" jsonschema:"OIDCUser name, as returned by list_oidc_users"`
	Refresh bool   `json:"refresh,omitempty" jsonschema:"Re-evaluate instead of reusing a recent answer"`
}

type serviceAccountsOutput struct {
	ServiceAccounts []useraccess.ServiceAccount `json:"serviceAccounts"`
}

type serviceAccountAccessInput struct {
	Namespace string `json:"namespace" jsonschema:"ServiceAccount namespace"`
	Name      string `json:"name" jsonschema:"ServiceAccount name"`
	Refresh   bool   `json:"refresh,omitempty" jsonschema:"Re-evaluate instead of reusing a recent answer"`
}

type myAccessInput struct {
	Refresh bool `json:"refresh,omitempty" jsonschema:"Re-evaluate instead of reusing a recent answer"`
}

func addUserAccessTools(s *mcp.Server, svc *useraccess.Service, m auth.Mapping) {
	mcp.AddTool(s, &mcp.Tool{
		Name:  "list_oidc_users",
		Title: "List OIDC users",
		Description: "List Passmower OIDCUsers: name, display name, emails, groups and last sign-in. Requires the caller's own RBAC to list oidcusers. " +
			"Does not evaluate rights; use get_oidc_user_access for one user.",
		InputSchema: noArguments(),
		Annotations: readOnly("List OIDC users"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, _ noInput) (*mcp.CallToolResult, oidcUsersOutput, error) {
		id, err := callerIdentity(req, m)
		if err != nil {
			return nil, oidcUsersOutput{}, err
		}
		users, err := svc.ListUsers(ctx, id)

		return nil, oidcUsersOutput{Users: users}, err
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:  "get_oidc_user_access",
		Title: "Show an OIDC user's effective rights",
		Description: "Evaluate one OIDCUser's effective Kubernetes rights, as the cluster authorizer answers SelfSubjectRulesReviews impersonating that user. " +
			"Requires the caller to get the OIDCUser and impersonate users and groups. clusterWide lists rules that apply in every namespace and to cluster-scoped resources; " +
			"namespaced lists only rights beyond those, with the namespaces they apply in. clusterAdmin collapses everything to full access. " +
			"Only namespaces where the user may list pods are examined; rights in others are not reported. Inspect incomplete and warnings before claiming completeness. " +
			"Answers are cached for a few minutes; evaluatedAt says when.",
		InputSchema: inputSchema[oidcUserAccessInput](func(p map[string]*jsonschema.Schema) {
			p["name"].MinLength = jsonschema.Ptr(1)
		}),
		Annotations: readOnly("Show an OIDC user's effective rights"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, in oidcUserAccessInput) (*mcp.CallToolResult, *useraccess.Access, error) {
		id, err := callerIdentity(req, m)
		if err != nil {
			return nil, nil, err
		}
		a, err := svc.Inspect(ctx, id, in.Name, in.Refresh)

		return nil, a, err
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:  "list_service_accounts",
		Title: "List ServiceAccounts",
		Description: "List every ServiceAccount with its creation time, its creator as admission recorded it in codemowers.io/created-by, " +
			"and whether a RoleBinding or ClusterRoleBinding names it. Requires the caller's own RBAC to list serviceaccounts, rolebindings and clusterrolebindings cluster-wide. " +
			"Does not evaluate rights; use get_service_account_access for one.",
		InputSchema: noArguments(),
		Annotations: readOnly("List ServiceAccounts"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, _ noInput) (*mcp.CallToolResult, serviceAccountsOutput, error) {
		id, err := callerIdentity(req, m)
		if err != nil {
			return nil, serviceAccountsOutput{}, err
		}
		sas, err := svc.ListServiceAccounts(ctx, id)

		return nil, serviceAccountsOutput{ServiceAccounts: sas}, err
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:  "get_service_account_access",
		Title: "Show a ServiceAccount's effective rights",
		Description: "Evaluate one ServiceAccount's effective Kubernetes rights, as the cluster authorizer answers SelfSubjectRulesReviews impersonating it with the groups its tokens carry. " +
			"Requires the caller to get and impersonate the ServiceAccount and impersonate groups. The answer has the same shape as get_oidc_user_access, with user.type ServiceAccount.",
		InputSchema: inputSchema[serviceAccountAccessInput](func(p map[string]*jsonschema.Schema) {
			p["namespace"].MinLength = jsonschema.Ptr(1)
			p["name"].MinLength = jsonschema.Ptr(1)
		}),
		Annotations: readOnly("Show a ServiceAccount's effective rights"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, in serviceAccountAccessInput) (*mcp.CallToolResult, *useraccess.Access, error) {
		id, err := callerIdentity(req, m)
		if err != nil {
			return nil, nil, err
		}
		a, err := svc.InspectServiceAccount(ctx, id, in.Namespace, in.Name, in.Refresh)

		return nil, a, err
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:  "get_my_access",
		Title: "Show my effective rights",
		Description: "Evaluate the caller's own effective Kubernetes rights, for the user and groups the API server sees in the caller's token. " +
			"Needs no extra permission. The answer has the same shape as get_oidc_user_access.",
		InputSchema: inputSchema[myAccessInput](nil),
		Annotations: readOnly("Show my effective rights"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, in myAccessInput) (*mcp.CallToolResult, *useraccess.Access, error) {
		id, err := callerIdentity(req, m)
		if err != nil {
			return nil, nil, err
		}
		a, err := svc.Self(ctx, id, in.Refresh)

		return nil, a, err
	})
}
