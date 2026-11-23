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
	"github.com/codemowers/driftmower/mcp/internal/useraccess"
)

// Deps are the services behind the tools. A nil service leaves its tools
// unregistered and its instructions out.
type Deps struct {
	ImageInventoryDisabled bool
	Cluster                cluster.Identity
	Version                string
	Logger                 *slog.Logger
	Metrics                *metrics.Metrics
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
	// Enables get_source_findings and get_workload_findings, which also need
	// Workloads.
	Findings     FindingsSource
	DriftHistory *observability.Service
	// Enables list_oidc_users, get_oidc_user_access, list_service_accounts and
	// get_service_account_access.
	UserAccess *useraccess.Service
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
	var s *mcp.Server
	dashboardSubscriptions(opts, d, &s)
	s = mcp.NewServer(&mcp.Implementation{Name: d.Cluster.MCPServerName, Version: d.Version}, opts)
	if d.Metrics != nil {
		s.AddReceivingMiddleware(toolMetrics(d.Metrics))
	}
	s.AddReceivingMiddleware(dashboardContent())

	s.AddResource(&mcp.Resource{
		Name:        "cluster-discovery-guide",
		URI:         "driftmower://cluster/discovery-guide",
		Title:       "Cluster identity and discovery workflow",
		Description: "Cluster identity and tool workflow for this connection.",
		MIMEType:    "text/plain",
	}, func(_ context.Context, req *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{
			{URI: req.Params.URI, MIMEType: "text/plain", Text: instructions},
		}}, nil
	})

	if d.Workloads != nil {
		addWorkloadTools(s, d.Workloads, d.Mapping)
		addWorkloadSourcesTool(s, d.Workloads, d.Mapping)
		if !d.ImageInventoryDisabled {
			addImageScanTool(s, d.Workloads, d.Mapping)
			addImageAnalysisTool(s, d.Workloads, d.Mapping)
		}
		addBaseImageTools(s, d.Workloads)
		addApplicationsTool(s, d.Workloads, d.Mapping)
		addOIDCClientsTool(s, d.Workloads, d.Mapping)
		addTrustBundlesTool(s, d.Workloads, d.Mapping)
		addHelmTool(s, d.Workloads, d.Mapping)
		addHelmReleaseTool(s, d.Workloads, d.Mapping)
		addWorkloadObjectTool(s, d.Workloads, d.Mapping)
		addPodProcessesTool(s, d.Workloads, d.Mapping)
		addImageMetadataTools(s, d.Workloads, d.Mapping)
		addMCPServersTool(s, d.Workloads, d.Mapping)
		addClusterRegistryTool(s, d.Workloads)
		// Reading as the caller needs the impersonation restart enables.
		if d.Workloads.Actions != nil {
			addOwnerRecordTool(s, d.Workloads, d.Mapping)
		}
	}
	addClusterIdentityTool(s, d.Cluster, usage)
	if d.Catalog != nil {
		addCatalogTools(s, d.Catalog, d.Cluster, d.Provisioning, d.Mapping)
	}
	if d.Scope != nil {
		addAccessibleNamespacesTool(s, d.Scope, d.Mapping)
	}
	if d.Findings != nil && d.Workloads != nil {
		addFindingsTools(s, d.Findings, d.Workloads, d.Mapping)
		if changes, ok := d.Findings.(ChangesSource); ok {
			addImageChangesTool(s, d.Findings, changes, d.Workloads, d.Mapping)
		}
	}
	if d.Workloads != nil {
		clusterID := d.Cluster.MCPServerName
		if d.Cluster.ID != nil {
			clusterID = *d.Cluster.ID
		}
		var prometheusURL func(context.Context) *string
		if d.Observability != nil {
			prometheusURL = d.Observability.PublicURL
		}
		addInventoryTools(s, d.Workloads, d.Mapping, clusterID, prometheusURL)
	}
	if d.DriftHistory != nil {
		addDriftHistoryTool(s, d.DriftHistory, d.Mapping)
	}
	if d.Observability != nil {
		if d.Workloads != nil && d.Observability.MetricsEnabled() {
			addImageScanStatusesTool(s, d.Observability, d.Mapping)
		}
		addObservabilityTools(s, d.Observability, d.Mapping)
		if d.Workloads != nil && d.Observability.LogsEnabled {
			addWorkloadLogsTool(s, d.Workloads, d.Observability, d.Mapping)
		}
		if d.Workloads != nil && d.Observability.MetricsEnabled() {
			addWorkloadUsageTool(s, d.Workloads, d.Observability, d.Mapping)
		}
		if d.Observability.MetricsEnabled() {
			addNamespaceSummariesTool(s, d.Observability, d.Mapping)
		}
		if d.Observability.LogRateEnabled() {
			addLogRateTool(s, d.Observability, d.Mapping)
		}
	}
	if d.Provisioning != nil {
		addProvisioningTools(s, d.Provisioning, d.Mapping, d.Logger)
	}
	if d.UserAccess != nil {
		addUserAccessTools(s, d.UserAccess, d.Mapping)
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

	add(d.Provisioning != nil, "To plan provisioning: describe_provisioning_platform, then list_offerings, then describe_namespace_readiness for the target namespaces; check_access for anything else. Authorization does not guarantee admission.")
	add(d.Catalog != nil, "For other APIs: list_custom_resource_definitions, then describe_custom_resource_definition before drafting a manifest; list_admission_policies before relying on admission defaults.")
	add(d.Workloads != nil, "Start workload questions with get_workloads.")
	add(d.Scope != nil, "Use list_accessible_namespaces when the namespace is unknown.")
	add(d.Findings != nil && d.Workloads != nil, "For drift and advisories use get_workload_findings or get_source_findings; no findings is not proof of none.")
	add(d.Workloads != nil && d.Workloads.Actions != nil, "restart_workload, terminate_pod and expand_volume mutate resources: use them only on explicit request.")
	add(true, "Missing metrics, logs or inventory are unknown, not zero or absent; check warnings and coverage.")

	return strings.Join(parts, " ")
}

// readOnly marks discovery tools. Shared so the set cannot drift per tool: a
// client deciding whether to auto-approve a call reads these.
func readOnly(title string) *mcp.ToolAnnotations {
	return &mcp.ToolAnnotations{
		Title:           title,
		ReadOnlyHint:    true,
		DestructiveHint: new(false),
		IdempotentHint:  true,
		OpenWorldHint:   new(false),
	}
}

func callerIdentity(req *mcp.CallToolRequest, m auth.Mapping) (authz.Identity, error) {
	return auth.KubernetesIdentity(auth.CallerFrom(req.Extra.TokenInfo), m)
}
