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
	if !svc.OIDCUsersDisabled {
		mcp.AddTool(s, &mcp.Tool{
			Name:        "list_oidc_users",
			Title:       "List OIDC users",
			Description: "Passmower OIDCUsers with emails, groups and last sign-in.",
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
			Name:        "get_oidc_user_access",
			Title:       "Show an OIDC user's effective rights",
			Description: "Effective Kubernetes rights of one OIDCUser via impersonated SelfSubjectRulesReviews: clusterWide rules, plus namespaced extras. Only namespaces where the user may list pods are examined. Cached for a few minutes.",
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

	}
	mcp.AddTool(s, &mcp.Tool{
		Name:        "list_service_accounts",
		Title:       "List ServiceAccounts",
		Description: "ServiceAccounts with creation time, codemowers.io/created-by and whether any binding names them.",
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
		Name:        "get_service_account_access",
		Title:       "Show a ServiceAccount's effective rights",
		Description: "Effective Kubernetes rights of one ServiceAccount, shaped like get_oidc_user_access.",
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
		Name:        "get_my_access",
		Title:       "Show my effective rights",
		Description: "The caller's own effective Kubernetes rights, shaped like get_oidc_user_access.",
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
