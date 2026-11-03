// Package mcpserver builds the MCP server: its identity, instructions,
// resource and tools.
package mcpserver

import (
	"context"
	"log/slog"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/catalog"
	"github.com/codemowers/driftmower/mcp/internal/cluster"
	"github.com/codemowers/driftmower/mcp/internal/logging"
	"github.com/codemowers/driftmower/mcp/internal/metrics"
	"github.com/codemowers/driftmower/mcp/internal/observability"
	"github.com/codemowers/driftmower/mcp/internal/provisioning/service"
)

// Deps are the services behind the tools. A nil service leaves its tools
// unregistered and its instructions out.
type Deps struct {
	Cluster cluster.Identity
	Version string
	Logger  *slog.Logger
	Metrics *metrics.Metrics
	// Maps verified callers to Kubernetes subjects.
	Mapping auth.Mapping
	// Enables list_accessible_namespaces.
	Scope *authz.ScopeResolver
	// Enables the cluster catalog tools.
	Catalog *catalog.Catalog
	// Enables the provisioning tools.
	Provisioning *service.Service
	// Enables the live workload tools.
	Workloads *Workloads
	// Enables list_volumes, and the metrics and logs tools it is configured
	// for.
	Observability *observability.Service
	// Enables search_workloads and plan_image_updates.
	Backend *Backend
	// Enables get_source_findings and get_workload_findings, which also need
	// Workloads.
	Findings FindingsSource
}

// New returns a server for every session. Per-caller state never lives on
// it: each call reads its caller from the request.
func New(d Deps) *mcp.Server {
	usage := usageInstructions(d)
	instructions := cluster.Instructions(d.Cluster) + " " + usage

	opts := &mcp.ServerOptions{Instructions: instructions, Logger: logging.AtLeast(d.Logger, slog.LevelWarn)}
	if d.Metrics != nil {
		opts.InitializedHandler = func(_ context.Context, req *mcp.InitializedRequest) {
			d.Metrics.Sessions.Inc()
			d.Metrics.OpenSessions.Inc()
			go func() {
				_ = req.Session.Wait()
				d.Metrics.OpenSessions.Dec()
			}()
		}
	}
	s := mcp.NewServer(&mcp.Implementation{Name: d.Cluster.MCPServerName, Version: d.Version}, opts)

	s.AddResource(&mcp.Resource{
		Name:        "cluster-discovery-guide",
		URI:         "driftmower://cluster/discovery-guide",
		Title:       "Cluster identity and discovery workflow",
		Description: "Start here for this connection’s cluster identity and enabled discovery, provisioning and observability tool workflow. Live facts come from the listed tools.",
		MIMEType:    "text/plain",
	}, func(_ context.Context, req *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{
			{URI: req.Params.URI, MIMEType: "text/plain", Text: instructions},
		}}, nil
	})

	if d.Workloads != nil {
		addWorkloadTools(s, d.Workloads, d.Mapping)
	}
	addClusterIdentityTool(s, d.Cluster, usage)
	if d.Catalog != nil {
		addCatalogTools(s, d.Catalog, d.Cluster, d.Provisioning, d.Mapping)
	}
	if d.Scope != nil {
		addAccessibleNamespacesTool(s, d.Scope, d.Mapping)
	}
	if d.Backend != nil {
		addBackendTools(s, d.Backend)
	}
	if d.Findings != nil && d.Workloads != nil {
		addFindingsTools(s, d.Findings, d.Workloads, d.Mapping)
	}
	if d.Observability != nil {
		addObservabilityTools(s, d.Observability, d.Mapping)
	}
	if d.Provisioning != nil {
		addProvisioningTools(s, d.Provisioning, d.Mapping, d.Logger)
	}

	return s
}

// usageInstructions describe the enabled tools, in a fixed order, so an agent
// learns the workflow from the handshake.
func usageInstructions(d Deps) string {
	var parts []string
	add := func(enabled bool, sentence string) {
		if enabled {
			parts = append(parts, sentence)
		}
	}

	add(d.Provisioning != nil, "When planning an application or provisioning resources, start with describe_provisioning_platform for discovered platform facts, then list_offerings for relevant databases, caches, queues or object stores. "+
		"Supply offering and the intended namespace when known. Before drafting manifests, use describe_namespace_readiness for the target namespaces and selected offering; use check_access for operations outside the offering catalog. "+
		"Read structuredContent and warnings: unavailable or unknown facts are not evidence that a capability is absent, and authorization does not guarantee admission.")
	add(d.Provisioning != nil, "Offering presets describe sizing intent, not effective configuration or established high availability. "+
		"Derive managed replica counts and fields to omit from applicable policy descriptions and bindings; a permitted range is not a configured count. "+
		"Verify placement, storage behavior, persistence, backups and recovery separately before claiming resilience. "+
		"Use namespace readiness to account for quota, LimitRange defaults, Pod Security and network constraints before deployment; choose explicit workload resources when defaults cannot support the application. "+
		"Reuse facts already gathered for the same target; repeat discovery when relevant state changes or a fact is missing. Namespace readiness lists creatable resource names; use check_access for one specific operation.")
	add(d.Catalog != nil, "Use list_custom_resource_definitions to discover installed custom-resource APIs beyond the offering catalog, then describe_custom_resource_definition for the selected API before drafting its manifest. "+
		"Discover ingress classes, cluster issuers and priority classes with the corresponding list tools only when needed. Installed APIs and catalog entries do not establish controller health or permission to use them.")
	add(d.Catalog != nil && d.Provisioning != nil, "Supply the target namespace to list_custom_resource_definitions to list only custom-resource APIs the caller can create there, without a permission matrix.")
	add(d.Catalog != nil, "Use list_admission_policies to discover policies and their bindings for the intended resource and namespace before relying on admission defaults or requirements. "+
		"Use list_storage_classes when selecting volume storage. Keep each resource or policy’s own defaults and requirements separate; do not assume optional components or redirect to an alternative whose availability has not been discovered.")
	add(d.Workloads != nil, "For applications, workload discovery, what runs in a namespace, and resource relationships, start with get_workloads. "+
		"Use a specified namespace directly; omit namespace only for an overview. Its text is a summary; read structuredContent for the inventory and inspect warnings before claiming completeness.")
	add(d.Scope != nil, "Use list_accessible_namespaces when namespace scope is unknown; visibility does not imply write permission.")
	add(d.Observability != nil && d.Observability.MetricsEnabled(), "For current resource usage, prefer get_pod_resource_usage or get_cluster_resource_usage. "+
		"Use their history endpoints only for trends, past usage, peaks or statistics. Use query_metrics for specific metrics outside those fixed summaries. Missing metrics or low coverage are not evidence of zero usage.")
	add(d.Findings != nil && d.Workloads != nil, "For version drift and security advisories, use get_workload_findings for a workload or namespace and get_source_findings across sources. "+
		"Findings are crawled every few hours; absence of findings is not proof of absence.")
	add(d.Backend != nil, "search_workloads reads backend report snapshots and may be stale or differently scoped; use live workload inventory when available for what is running now.")
	add(d.Workloads != nil && d.Workloads.Actions != nil, "restart_workload and terminate_pod mutate resources. "+
		"Use only for an explicit user request, using UID from current workload inventory; never treat them as diagnostic probes or automatically retry uncertain results.")
	add(true, "Use only tools exposed by this connection. Narrow requests to the namespace, pod, metric or resource needed; avoid collecting unrelated namespaces or histories.")

	return strings.Join(parts, " ")
}

func boolPtr(b bool) *bool { return &b }

// readOnly marks discovery tools. Shared so the set cannot drift per tool: a
// client deciding whether to auto-approve a call reads these.
func readOnly(title string) *mcp.ToolAnnotations {
	return &mcp.ToolAnnotations{
		Title:           title,
		ReadOnlyHint:    true,
		DestructiveHint: boolPtr(false),
		IdempotentHint:  true,
		OpenWorldHint:   boolPtr(false),
	}
}

// callerIdentity maps the request's verified caller to a Kubernetes subject.
func callerIdentity(req *mcp.CallToolRequest, m auth.Mapping) (authz.Identity, error) {
	return auth.KubernetesIdentity(auth.CallerFrom(req.Extra.TokenInfo), m)
}
