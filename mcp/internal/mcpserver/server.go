// Package mcpserver builds the MCP server: its identity, instructions,
// resource and tools.
package mcpserver

import (
	"context"
	"log/slog"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/codemowers/driftmower-mcp/internal/auth"
	"github.com/codemowers/driftmower-mcp/internal/authz"
	"github.com/codemowers/driftmower-mcp/internal/cluster"
	"github.com/codemowers/driftmower-mcp/internal/logging"
	"github.com/codemowers/driftmower-mcp/internal/metrics"
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

	addClusterIdentityTool(s, d.Cluster, usage)
	if d.Scope != nil {
		addAccessibleNamespacesTool(s, d.Scope, d.Mapping)
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

	add(d.Scope != nil, "Use list_accessible_namespaces when namespace scope is unknown; visibility does not imply write permission.")
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
