package mcpserver

import (
	"context"
	"log/slog"
	"maps"
	"slices"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/provisioning"
	"github.com/codemowers/driftmower/mcp/internal/provisioning/service"
)

// Identity comes only from the verified transport context. An
// unauthenticated call (stdio, auth off) still gets every fact, with
// permission verdicts reported as unknown rather than refused.
func identityOrNil(req *mcp.CallToolRequest, m auth.Mapping) *authz.Identity {
	id, err := callerIdentity(req, m)
	if err != nil {
		return nil
	}

	return &id
}

// unavailableError reports an unreadable Kubernetes API as a tool error, in
// the same prose the facts would have come in.
type unavailableError struct{ u *service.Unavailable }

func (e unavailableError) Error() string { return service.FormatUnavailable(e.u) }

func text(markdown string) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: markdown}}}
}

type provisioningTools struct {
	svc     *service.Service
	mapping auth.Mapping
	logger  *slog.Logger
}

func (p provisioningTools) audit(tool string, req *mcp.CallToolRequest, outcome, arg string) {
	p.logger.Info("tool call", "tool", tool, "sub", auth.Subject(auth.CallerFrom(req.Extra.TokenInfo)), "arg", arg, "outcome", outcome)
}

type listOfferingsInput struct {
	Offering  string `json:"offering,omitempty"`
	Namespace string `json:"namespace,omitempty"`
}

type readinessInput struct {
	Namespaces []string `json:"namespaces"`
	Offering   string   `json:"offering,omitempty"`
}

type readinessNamespace struct {
	provisioning.NamespaceFact
	// Hide the matrix; expose creatable names only.
	Access             *provisioning.AccessProfile `json:"access,omitempty"`
	CreatableResources []string                    `json:"creatableResources"`
}

type readinessOutput struct {
	service.Readiness
	Namespaces []readinessNamespace `json:"namespaces"`
}

type checkAccessInput struct {
	Verb        string `json:"verb"`
	Group       string `json:"group,omitempty"`
	Resource    string `json:"resource"`
	Subresource string `json:"subresource,omitempty"`
	Namespace   string `json:"namespace,omitempty"`
	Name        string `json:"name,omitempty"`
}

var checkVerbs = []string{"get", "list", "watch", "create", "update", "patch", "delete", "deletecollection", "proxy"}

func addProvisioningTools(s *mcp.Server, svc *service.Service, m auth.Mapping, logger *slog.Logger) {
	p := provisioningTools{svc: svc, mapping: m, logger: logger}

	mcp.AddTool(s, &mcp.Tool{
		Name:        "describe_provisioning_platform",
		Title:       "Describe the provisioning platform",
		InputSchema: noArguments(),
		Description: "Use for an initial interpreted overview when planning provisioning or choosing platform capabilities. Returns cluster facts for provisioning: storage classes and what each implies for data, zones and " +
			"schedulable nodes, priority classes, the published ingress domain and TLS advice, enforced admission " +
			"policies and the tenant label they scope on, Kyverno policies, the network policy engine and whether " +
			"the Prometheus operator is present. Everything is discovered from the cluster; an optional component " +
			"that is absent degrades one fact rather than the answer. Read-only. For raw CRD and catalog listings " +
			"use list_custom_resource_definitions, list_ingress_classes, list_cluster_issuers and list_priority_classes.",
		OutputSchema: schemaFor[*service.Platform](),
		Annotations:  readOnly("Describe the provisioning platform"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, _ noInput) (*mcp.CallToolResult, *service.Platform, error) {
		result, u := svc.DescribePlatform(ctx)
		if u != nil {
			p.audit("describe_provisioning_platform", req, u.Status, "")

			return nil, nil, unavailableError{u}
		}
		p.audit("describe_provisioning_platform", req, result.Status, "")

		return text(service.FormatPlatform(result)), result, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:  "list_offerings",
		Title: "List provisionable offerings",
		Description: "Use to choose a supported database, cache, queue or object-store offering; supply offering to narrow the catalog and namespace to check creation permissions. Returns each offering with whether it is " +
			"actually available on this cluster and, when it is not, why, plus the admission defaults that " +
			"rewrite its resources on create, each with what its policy says it requires. Presets describe sizing intent, not configured replica counts, placement or backups; discover applicable policies before selecting those settings. With `namespace`, each offering also " +
			"carries whether the cluster authorizer lets you create it there, checked as the verified caller for " +
			"every resource the offering needs, with enforced admission policies considered. Read-only.",
		InputSchema: inputSchema[listOfferingsInput](func(props map[string]*jsonschema.Schema) {
			props["offering"].Enum = enumOf(provisioning.OfferingIDs)
			namespaceProperty(props["namespace"])
		}),
		OutputSchema: schemaFor[*service.Offerings](),
		Annotations:  readOnly("List provisionable offerings"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, in listOfferingsInput) (*mcp.CallToolResult, *service.Offerings, error) {
		arg := strings.TrimSpace(in.Offering + " " + in.Namespace)
		result, u := svc.ListOfferings(ctx, identityOrNil(req, m), provisioning.OfferingID(in.Offering), strings.TrimSpace(in.Namespace))
		if u != nil {
			p.audit("list_offerings", req, u.Status, arg)

			return nil, nil, unavailableError{u}
		}
		p.audit("list_offerings", req, result.Status, arg)

		return text(service.FormatOfferings(result)), result, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:  "describe_namespace_readiness",
		Title: "Describe namespace readiness",
		Description: "Use before provisioning in known namespaces to assess readiness and constraints. Pass only relevant namespaces; add offering for an offering-specific creation check. Returns quota and remaining headroom, LimitRange defaults, network posture and " +
			"any policies that select on an exact instance name, Pod Security enforcement, the hostnames the " +
			"namespace may claim, any container registry published from the namespace with the skaffold.env " +
			"to build against it, and your access there as the cluster authorizer reports it (per resource type " +
			"as a plain creatableResources array, without a permission matrix). With `offering`, whether you " +
			"may create that offering there. Namespaces where you may not list pods are withheld, not empty. " +
			"Read-only.",
		InputSchema: inputSchema[readinessInput](func(props map[string]*jsonschema.Schema) {
			ns := props["namespaces"]
			ns.Types, ns.Type = nil, "array"
			ns.MinItems, ns.MaxItems = jsonschema.Ptr(1), jsonschema.Ptr(svc.MaxNamespaces)
			namespaceProperty(ns.Items)
			props["offering"].Enum = enumOf(provisioning.OfferingIDs)
		}),
		OutputSchema: schemaFor[*readinessOutput](),
		Annotations:  readOnly("Describe namespace readiness"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, in readinessInput) (*mcp.CallToolResult, *readinessOutput, error) {
		arg := strings.Join(in.Namespaces, ",")
		result, u := svc.DescribeNamespaceReadiness(ctx, identityOrNil(req, m), in.Namespaces, provisioning.OfferingID(in.Offering))
		if u != nil {
			p.audit("describe_namespace_readiness", req, u.Status, arg)

			return nil, nil, unavailableError{u}
		}
		p.audit("describe_namespace_readiness", req, result.Status, arg)

		out := &readinessOutput{Readiness: *result, Namespaces: []readinessNamespace{}}
		for _, f := range result.Namespaces {
			n := readinessNamespace{NamespaceFact: f}
			if f.Access != nil {
				n.CreatableResources = []string{}
				for _, key := range slices.Sorted(maps.Keys(f.Access.Matrix)) {
					if f.Access.Matrix[key]["create"] == authz.Yes {
						n.CreatableResources = append(n.CreatableResources, key)
					}
				}
			}
			out.Namespaces = append(out.Namespaces, n)
		}

		return text(service.FormatReadiness(result, false)), out, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:  "check_access",
		Title: "Check one permission",
		Description: "Use before a specific operation to check authorization; namespace visibility alone is insufficient. Supply API group, plural resource name and verb (plus namespace/name when applicable). Asks the cluster authorizer, as the verified caller, whether the operation is allowed: " +
			"any group and resource, cluster-scoped or in a namespace, subresources such as pods/log, a named " +
			"object. Discovered enforced admission constraints are reported alongside; an " +
			"RBAC yes does not guarantee that create, update or delete will pass admission, including conditions this tool cannot evaluate. For create and update it also lists the mutating admission " +
			"policies that rewrite the object, with what each says it requires, such as a Secret to provision first. " +
			"Use it for anything outside the offering catalog. Read-only.",
		InputSchema: inputSchema[checkAccessInput](func(props map[string]*jsonschema.Schema) {
			props["verb"].Enum = enumOf(checkVerbs)
			props["group"].MaxLength = jsonschema.Ptr(253)
			props["group"].Default = defaultValue("")
			props["resource"].MinLength, props["resource"].MaxLength = jsonschema.Ptr(1), jsonschema.Ptr(253)
			props["subresource"].MinLength, props["subresource"].MaxLength = jsonschema.Ptr(1), jsonschema.Ptr(63)
			props["name"].MinLength, props["name"].MaxLength = jsonschema.Ptr(1), jsonschema.Ptr(253)
			namespaceProperty(props["namespace"])
		}),
		OutputSchema: schemaFor[*service.AccessCheck](),
		Annotations:  readOnly("Check one permission"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, in checkAccessInput) (*mcp.CallToolResult, *service.AccessCheck, error) {
		input := service.AccessCheckInput{
			Verb: in.Verb, Group: strings.TrimSpace(in.Group), Resource: strings.TrimSpace(in.Resource),
			Subresource: strings.TrimSpace(in.Subresource), Namespace: strings.TrimSpace(in.Namespace), Name: strings.TrimSpace(in.Name),
		}
		arg := input.Verb + " " + input.Resource + "." + core(input.Group)
		if input.Namespace != "" {
			arg += " ns=" + input.Namespace
		}
		result, u := svc.CheckAccess(ctx, identityOrNil(req, m), input)
		if u != nil {
			p.audit("check_access", req, u.Status, arg)

			return nil, nil, unavailableError{u}
		}
		p.audit("check_access", req, string(result.Verdict), arg)

		return text(service.FormatAccessCheck(result, input)), result, nil
	})
}

func core(group string) string {
	if group == "" {
		return "core"
	}

	return group
}
