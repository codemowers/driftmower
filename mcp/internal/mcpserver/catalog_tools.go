package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"golang.org/x/sync/errgroup"

	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/catalog"
	"github.com/codemowers/driftmower/mcp/internal/cluster"
	"github.com/codemowers/driftmower/mcp/internal/provisioning"
	"github.com/codemowers/driftmower/mcp/internal/provisioning/service"
)

var errCatalogCaller = errors.New("cluster catalog requires an authenticated caller")

func requireCaller(req *mcp.CallToolRequest) error {
	if c := auth.CallerFrom(req.Extra.TokenInfo); c == nil || c.Sub == "" {
		return errCatalogCaller
	}

	return nil
}

type crdListInput struct {
	Scope     string `json:"scope,omitempty"`
	Namespace string `json:"namespace,omitempty"`
}

type crdListOutput struct {
	CustomResources []catalog.CustomResource `json:"customResources"`
}

type crdDescribeInput struct {
	Name    string `json:"name"`
	Version string `json:"version,omitempty"`
	Path    string `json:"path,omitempty"`
	Depth   int    `json:"depth,omitempty"`
}

type admissionPoliciesInput struct {
	Resource string `json:"resource,omitempty"`
}

type ingressClass struct {
	Name       string `json:"name"`
	Controller string `json:"controller"`
}

type priorityClass struct {
	Name        string  `json:"name"`
	Value       int32   `json:"value"`
	Description *string `json:"description"`
}

type ingressClassesOutput struct {
	IngressClasses []ingressClass     `json:"ingressClasses"`
	Degraded       []catalog.Degraded `json:"degraded"`
}

type priorityClassesOutput struct {
	PriorityClasses []priorityClass    `json:"priorityClasses"`
	Degraded        []catalog.Degraded `json:"degraded"`
}

type clusterIssuersOutput struct {
	ClusterIssuers []catalog.ClusterIssuer `json:"clusterIssuers"`
	Degraded       []catalog.Degraded      `json:"degraded"`
}

func addCatalogTools(s *mcp.Server, cat *catalog.Catalog, c cluster.Identity, svc *service.Service, m auth.Mapping) {
	addAdmissionPoliciesTool(s, cat)
	id := "identity unconfigured"
	if c.ID != nil {
		id = *c.ID
	}
	createScope := "Installed APIs do not establish caller authorization. "
	if svc != nil {
		createScope = "Supply the intended namespace to return only APIs the verified caller can create there; cluster-scoped APIs are checked without a namespace. " +
			"Omit namespace only for installed-API discovery, which does not establish authorization. "
	}

	mcp.AddTool(s, &mcp.Tool{
		Name:  "list_custom_resource_definitions",
		Title: "List custom resource definitions (" + id + ")",
		Description: "Use to discover which custom-resource APIs are installed before planning resources. Returns an array of API identities and operator-authored descriptions, without permission fields. " +
			"Defaults to Namespaced APIs; choose Cluster or All explicitly to include cluster-scoped APIs. " + createScope +
			"API existence does not establish operator health. Use describe_custom_resource_definition for a selected CRD schema; use get_workloads when available for existing workload roots.",
		InputSchema: inputSchema[crdListInput](func(props map[string]*jsonschema.Schema) {
			props["scope"].Enum = []any{"Namespaced", "Cluster", "All"}
			props["scope"].Default = defaultValue("Namespaced")
			if svc == nil {
				delete(props, "namespace")
			} else {
				namespaceProperty(props["namespace"])
			}
		}),
		Annotations: readOnly("List custom resource definitions"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, in crdListInput) (*mcp.CallToolResult, crdListOutput, error) {
		if err := requireCaller(req); err != nil {
			return nil, crdListOutput{}, err
		}
		all, err := cat.CustomResourceDefinitions(ctx)
		if err != nil {
			return nil, crdListOutput{}, err
		}
		scope := in.Scope
		if scope == "" {
			scope = "Namespaced"
		}
		items := slices.DeleteFunc(all, func(r catalog.CustomResource) bool { return scope != "All" && r.Scope != scope })

		if namespace := strings.TrimSpace(in.Namespace); svc != nil && namespace != "" {
			id, err := callerIdentity(req, m)
			if err != nil {
				return nil, crdListOutput{}, err
			}
			creatable := make([]bool, len(items))
			g, gctx := errgroup.WithContext(ctx)
			g.SetLimit(8)
			for i, r := range items {
				g.Go(func() error {
					input := service.AccessCheckInput{Verb: "create", Group: r.Group, Resource: r.Resource}
					if r.Scope == "Namespaced" {
						input.Namespace = namespace
					}
					result, u := svc.CheckAccess(gctx, &id, input)
					if u != nil || result.Verdict == authz.Unknown {
						return fmt.Errorf("could not determine creation access for %s", r.Name)
					}
					creatable[i] = result.Verdict == authz.Yes

					return nil
				})
			}
			if err := g.Wait(); err != nil {
				return nil, crdListOutput{}, err
			}
			var kept []catalog.CustomResource
			for i, r := range items {
				if creatable[i] {
					kept = append(kept, r)
				}
			}
			items = kept
		}
		if items == nil {
			items = []catalog.CustomResource{}
		}

		return nil, crdListOutput{CustomResources: items}, nil
	})

	issuerVersion := func(ctx context.Context) (string, error) {
		crds, err := cat.CustomResourceDefinitions(ctx)
		if err != nil {
			return "", err
		}
		for _, r := range crds {
			if r.Name == "clusterissuers.cert-manager.io" && r.Established && !r.Terminating {
				return r.PreferredServedVersion(), nil
			}
		}

		return "", nil
	}

	mcp.AddTool(s, &mcp.Tool{
		Name:         "list_ingress_classes",
		Title:        "List ingress classes",
		InputSchema:  noArguments(),
		Description:  "Use to choose an installed ingressClassName. Returns ingress classes and their controllers; class existence does not verify controller health, routing, DNS or TLS.",
		OutputSchema: schemaFor[ingressClassesOutput](),
		Annotations:  readOnly("List ingress classes"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, _ noInput) (*mcp.CallToolResult, ingressClassesOutput, error) {
		if err := requireCaller(req); err != nil {
			return nil, ingressClassesOutput{}, err
		}
		classes := cat.PlatformClasses(ctx, "", catalog.OnlyIngressClasses)
		out := ingressClassesOutput{Degraded: classes.Degraded}
		if classes.IngressClasses != nil {
			out.IngressClasses = []ingressClass{}
			for _, c := range classes.IngressClasses {
				out.IngressClasses = append(out.IngressClasses, ingressClass{Name: c.Name, Controller: c.Controller})
			}
		}

		return nil, out, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:        "list_cluster_issuers",
		Title:       "List cluster issuers",
		InputSchema: noArguments(),
		Description: "Use to discover available cluster-scoped cert-manager issuers before selecting one for a Certificate. Returns their own descriptions, reported readiness and ACME solver types when the API is installed. " +
			"Null means the catalog is unavailable; an empty list means none were found. Do not infer namespace-scoped Issuer availability from this catalog.",
		OutputSchema: schemaFor[clusterIssuersOutput](),
		Annotations:  readOnly("List cluster issuers"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, _ noInput) (*mcp.CallToolResult, clusterIssuersOutput, error) {
		if err := requireCaller(req); err != nil {
			return nil, clusterIssuersOutput{}, err
		}
		version, err := issuerVersion(ctx)
		if err != nil {
			return nil, clusterIssuersOutput{}, err
		}
		classes := cat.PlatformClasses(ctx, version, catalog.OnlyClusterIssuers)

		return nil, clusterIssuersOutput{ClusterIssuers: classes.ClusterIssuers, Degraded: classes.Degraded}, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:        "list_priority_classes",
		Title:       "List priority classes",
		InputSchema: noArguments(),
		Description: "Use to choose an installed priorityClassName. Returns classes sorted by ascending numeric priority, with values and descriptions. " +
			"Larger values have higher scheduling priority; class existence does not authorize its use or guarantee capacity.",
		OutputSchema: schemaFor[priorityClassesOutput](),
		Annotations:  readOnly("List priority classes"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, _ noInput) (*mcp.CallToolResult, priorityClassesOutput, error) {
		if err := requireCaller(req); err != nil {
			return nil, priorityClassesOutput{}, err
		}
		classes := cat.PlatformClasses(ctx, "", catalog.OnlyPriorityClasses)
		out := priorityClassesOutput{Degraded: classes.Degraded}
		if classes.PriorityClasses != nil {
			out.PriorityClasses = []priorityClass{}
			for _, c := range classes.PriorityClasses {
				out.PriorityClasses = append(out.PriorityClasses, priorityClass{Name: c.Name, Value: c.Value, Description: c.Description})
			}
		}

		return nil, out, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:  "describe_custom_resource_definition",
		Title: "Describe a custom resource definition",
		Description: "Use after selecting a CRD from list_custom_resource_definitions to inspect its writable fields before drafting a custom resource. " +
			"Supply the full CRD name (plural.group), not Kind.group or an object name. Returns every served API version and the writable resource schema of one: the storage version unless version names another served one. " +
			"The schema starts at path (the whole object when omitted) and keeps depth levels of fields; deeper objects list their fields under elidedFields, so pass that object's path to read them. " +
			"Excludes status, controller metadata and CEL code.",
		InputSchema: inputSchema[crdDescribeInput](func(props map[string]*jsonschema.Schema) {
			props["name"].Pattern = `^[a-z0-9][a-z0-9.-]*$`
			props["version"].Description = "Served version whose schema to return, e.g. v1beta1. Defaults to the storage version."
			props["version"].Pattern = `^v[0-9]+((alpha|beta)[0-9]+)?$`
			props["path"].Description = "Dot-separated field path to start the schema at, e.g. spec.template.spec. Array items and map values are passed through, so spec.containers.image is a container's image."
			props["path"].Pattern = `^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$`
			props["depth"].Description = "Levels of fields to keep below path. When omitted, the deepest level up to 3 whose schema stays small enough to read inline."
			props["depth"].Minimum, props["depth"].Maximum = jsonschema.Ptr(1.0), jsonschema.Ptr(8.0)
		}),
		Annotations: readOnly("Describe a custom resource definition"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, in crdDescribeInput) (*mcp.CallToolResult, catalog.CRDDetails, error) {
		if err := requireCaller(req); err != nil {
			return nil, catalog.CRDDetails{}, err
		}
		d, err := cat.DescribeCRD(ctx, in.Name)
		if err != nil {
			return nil, catalog.CRDDetails{}, err
		}
		if d, err = d.Only(in.Version); err != nil {
			return nil, catalog.CRDDetails{}, err
		}
		if in.Depth > 0 {
			d, err = d.Focus(in.Path, in.Depth)

			return nil, d, err
		}

		d, err = focusWithinBudget(d, in.Path)

		return nil, d, err
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:        "list_storage_classes",
		Title:       "List storage classes",
		InputSchema: noArguments(),
		Description: "Use to choose storageClassName and understand volume binding, expansion and reclaim behavior. Lists live Kubernetes StorageClasses with provisioning guidance from kubernetes.io/description and structured settings: " +
			"provisioner, filesystemType, driver parameters, reclaimPolicy, volumeBindingMode, allowVolumeExpansion, mountOptions, and allowedTopologies. " +
			"Missing descriptions and unspecified filesystem types are null. Cluster-wide capability metadata for authenticated callers.",
		OutputSchema: schemaFor[storageClassesOutput](),
		Annotations:  readOnly("List storage classes"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, _ noInput) (*mcp.CallToolResult, storageClassesOutput, error) {
		if err := requireCaller(req); err != nil {
			return nil, storageClassesOutput{}, err
		}
		classes, err := cat.StorageClasses(ctx)

		return nil, storageClassesOutput{StorageClasses: classes}, err
	})

	// The catalog is returned as CSV only: on a cluster with a hundred
	// policies the JSON form alone outgrows what MCP clients accept inline.
	mcp.AddTool(s, &mcp.Tool{
		Name:  "list_admission_policies",
		Title: "List admission policies",
		InputSchema: inputSchema[admissionPoliciesInput](func(props map[string]*jsonschema.Schema) {
			props["resource"].Description = "Plural resource name, optionally qualified by API group (ingresses.networking.k8s.io; core resources take no group). " +
				"Keeps policies whose own resource rules could match it; unqualified, any group matches. Omit for the whole catalog."
			props["resource"].Pattern = `^[a-z0-9][a-z0-9.-]*$`
		}),
		Description: "Use before planning resource changes to discover admission requirements and applicable bindings. Returns a CSV catalog of admission policy names, descriptions and target resource rules/selectors, plus binding names and scope restrictions. " +
			"Pass resource to keep only policies that could target it; a large catalog may otherwise be too long to read inline. " +
			"No policy code is returned. conditional indicates additional conditions or parameters that this summary does not evaluate. " +
			"bindings=null means discovery is unavailable; [] means no bindings. Match resource rules and binding scope to the intended resource; targets are candidates, not a prediction of effective admission behavior. " +
			"This catalog does not evaluate policy conditions or replace an authorization check.",
		Annotations: readOnly("List admission policies"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, in admissionPoliciesInput) (*mcp.CallToolResult, any, error) {
		if err := requireCaller(req); err != nil {
			return nil, nil, err
		}
		policies, err := cat.AdmissionPolicies(ctx)
		if err != nil {
			return nil, nil, err
		}
		resource, group, qualified := strings.Cut(in.Resource, ".")
		out := policyCatalogOutput{Policies: []policySummary{}, UnavailableKinds: policies.UnavailableKinds}
		for _, p := range policies.Policies {
			if in.Resource == "" || p.Targets(group, resource, !qualified) {
				out.Policies = append(out.Policies, summarizePolicy(p))
			}
		}
		csv := policyCatalogCSV(out)
		if in.Resource != "" {
			csv += fmt.Sprintf("\nFiltered to %d of %d policies whose own rules could target %s; bindings may narrow them further.\n", len(out.Policies), len(policies.Policies), in.Resource)
		}

		return text(csv), nil, nil
	})
}

// The dashboard's view of the same catalog: structured, with the creator
// admission recorded on each policy.
// The catalog for the dashboard, structured. Admission never runs on
// admission policies, so no creator is recorded on them.
type dashboardPolicy struct {
	policySummary
}

type dashboardPoliciesOutput struct {
	Policies         []dashboardPolicy `json:"policies"`
	UnavailableKinds []string          `json:"unavailableKinds"`
}

func addAdmissionPoliciesTool(s *mcp.Server, cat *catalog.Catalog) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "get_admission_policies",
		Title:       "Get admission policies",
		InputSchema: noArguments(),
		Description: "The admission policy catalog as structured data, validating and mutating, sorted by name: each policy's description, target resource rules and bindings. " +
			"For planning prefer list_admission_policies, whose CSV stays small on large catalogs.",
		Annotations: readOnly("Get admission policies"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, _ noInput) (*mcp.CallToolResult, *dashboardPoliciesOutput, error) {
		if err := requireCaller(req); err != nil {
			return nil, nil, err
		}
		policies, err := cat.AdmissionPolicies(ctx)
		if err != nil {
			return nil, nil, err
		}
		out := &dashboardPoliciesOutput{Policies: []dashboardPolicy{}, UnavailableKinds: policies.UnavailableKinds}
		for _, p := range policies.Policies {
			out.Policies = append(out.Policies, dashboardPolicy{policySummary: summarizePolicy(p)})
		}
		slices.SortFunc(out.Policies, func(a, b dashboardPolicy) int { return strings.Compare(a.Name, b.Name) })

		return nil, out, nil
	})
}

type storageClassesOutput struct {
	StorageClasses []catalog.StorageClass `json:"storageClasses"`
}

// Only allowlisted matching metadata crosses the tool boundary: never policy
// specs, CEL expressions, variables, mutations or referenced parameters.
type policySummary struct {
	Name        string            `json:"name"`
	Description *string           `json:"description"`
	Kind        string            `json:"kind"`
	Targets     *catalog.Matching `json:"targets,omitempty"`
	// Additional conditions or parameters this summary does not evaluate.
	Conditional bool `json:"conditional"`
	// Nil when binding discovery is unavailable.
	Bindings []bindingSummary `json:"bindings"`
}

type bindingSummary struct {
	Name              string            `json:"name"`
	Targets           *catalog.Matching `json:"targets,omitempty"`
	ValidationActions []string          `json:"validationActions,omitempty"`
}

type policyCatalogOutput struct {
	Policies         []policySummary `json:"policies"`
	UnavailableKinds []string        `json:"unavailableKinds"`
}

func compactMatching(m *catalog.Matching) *catalog.Matching {
	if m == nil {
		return nil
	}
	c := *m
	c.MatchPolicy = ""
	if c.NamespaceSelector != nil && len(c.NamespaceSelector.MatchLabels) == 0 && len(c.NamespaceSelector.MatchExpressions) == 0 {
		c.NamespaceSelector = nil
	}
	if c.ObjectSelector != nil && len(c.ObjectSelector.MatchLabels) == 0 && len(c.ObjectSelector.MatchExpressions) == 0 {
		c.ObjectSelector = nil
	}
	if c.NamespaceSelector == nil && c.ObjectSelector == nil && len(c.ResourceRules) == 0 && len(c.ExcludeResourceRules) == 0 {
		return nil
	}

	return &c
}

func summarizePolicy(p catalog.AdmissionPolicy) policySummary {
	s := policySummary{
		Name:        p.Name,
		Description: p.Description,
		Kind:        p.Kind,
		Targets:     compactMatching(p.Spec.MatchConstraints),
		Conditional: len(p.Spec.MatchConditions) > 0 || p.Spec.ParamKind != nil,
	}
	if p.Bindings != nil {
		s.Bindings = []bindingSummary{}
		for _, b := range p.Bindings {
			s.Bindings = append(s.Bindings, bindingSummary{Name: b.Name, Targets: compactMatching(b.Spec.MatchResources), ValidationActions: b.Spec.ValidationActions})
		}
	}

	return s
}

var csvNeedsQuoting = regexp.MustCompile(`[",\r\n]`)

func csvLine(values []string) string {
	for i, v := range values {
		if csvNeedsQuoting.MatchString(v) {
			values[i] = `"` + strings.ReplaceAll(v, `"`, `""`) + `"`
		}
	}

	return strings.Join(values, ",")
}

func formatRules(rules []catalog.Rule) string {
	parts := make([]string, len(rules))
	for i, r := range rules {
		groups, resources := r.APIGroups, r.Resources
		if groups == nil {
			groups = []string{"*"}
		}
		if resources == nil {
			resources = []string{"*"}
		}
		var targets []string
		for _, g := range groups {
			for _, res := range resources {
				targets = append(targets, res+"."+core(g))
			}
		}
		terms := []string{strings.Join(targets, "|")}
		if len(r.APIVersions) > 0 {
			terms = append(terms, "versions="+strings.Join(r.APIVersions, "|"))
		}
		if len(r.Operations) > 0 {
			terms = append(terms, "operations="+strings.Join(r.Operations, "|"))
		}
		if len(r.ResourceNames) > 0 {
			terms = append(terms, "names="+strings.Join(r.ResourceNames, "|"))
		}
		if r.Scope != "" && r.Scope != "*" {
			terms = append(terms, "scope="+r.Scope)
		}
		parts[i] = strings.Join(terms, " ")
	}

	return strings.Join(parts, "; ")
}

func formatTargets(m *catalog.Matching) string {
	if m == nil {
		return "all"
	}
	rules := formatRules(m.ResourceRules)
	if rules == "" {
		rules = "all"
	}
	parts := []string{rules}
	if len(m.ExcludeResourceRules) > 0 {
		parts = append(parts, "exclude: "+formatRules(m.ExcludeResourceRules))
	}
	for i, sel := range []*provisioning.LabelSelector{m.NamespaceSelector, m.ObjectSelector} {
		if terms := selectorTerms(sel); len(terms) > 0 {
			kind := "namespace"
			if i == 1 {
				kind = "object"
			}
			parts = append(parts, kind+": "+strings.Join(terms, " & "))
		}
	}

	return strings.Join(parts, "; ")
}

func selectorTerms(s *provisioning.LabelSelector) []string {
	if s == nil {
		return nil
	}
	var terms []string
	for _, k := range slices.Sorted(maps.Keys(s.MatchLabels)) {
		terms = append(terms, k+"="+s.MatchLabels[k])
	}
	for _, e := range s.MatchExpressions {
		terms = append(terms, e.Key+" "+e.Operator+" ("+strings.Join(e.Values, "|")+")")
	}

	return terms
}

func policyCatalogCSV(c policyCatalogOutput) string {
	rows := []string{csvLine([]string{"name", "description", "kind", "targets", "bindings", "conditional"})}
	for _, p := range c.Policies {
		bindings := "unavailable"
		switch {
		case p.Bindings == nil:
		case len(p.Bindings) == 0:
			bindings = "none"
		default:
			parts := make([]string, len(p.Bindings))
			for i, b := range p.Bindings {
				parts[i] = b.Name + ": " + formatTargets(b.Targets)
				if len(b.ValidationActions) > 0 {
					parts[i] += " [" + strings.Join(b.ValidationActions, "|") + "]"
				}
			}
			bindings = strings.Join(parts, "; ")
		}
		description := ""
		if p.Description != nil {
			description = *p.Description
		}
		rows = append(rows, csvLine([]string{p.Name, description, p.Kind, formatTargets(p.Targets), bindings, fmt.Sprint(p.Conditional)}))
	}
	out := strings.Join(rows, "\n") + "\n"
	if len(c.UnavailableKinds) > 0 {
		out += "\nUnavailable policy APIs: " + strings.Join(c.UnavailableKinds, ", ") + "\n"
	}

	return out
}

// crdSchemaBudget bounds a described schema chosen without an explicit depth;
// wide schemas such as an operator's whole cluster spec run to megabytes.
const crdSchemaBudget = 32 << 10

// focusWithinBudget keeps the deepest level, up to the default, whose JSON
// fits the budget, and one level when none does.
func focusWithinBudget(d catalog.CRDDetails, path string) (catalog.CRDDetails, error) {
	var focused catalog.CRDDetails
	for depth := catalog.DefaultSchemaDepth; depth >= 1; depth-- {
		var err error
		if focused, err = d.Focus(path, depth); err != nil {
			return catalog.CRDDetails{}, err
		}
		if b, err := json.Marshal(focused); err == nil && len(b) <= crdSchemaBudget {
			break
		}
	}

	return focused, nil
}
