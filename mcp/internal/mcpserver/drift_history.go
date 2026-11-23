package mcpserver

import (
	"context"

	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/observability"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func addDriftHistoryTool(s *mcp.Server, history *observability.Service, mapping auth.Mapping) {
	mcp.AddTool(s, &mcp.Tool{Name: "query_outdated_workloads", Title: "Read most outdated workloads", Description: "Current top five workloads by observed stable releases behind, worst image per workload. Prometheus observations only; missing coverage is unknown, independent of historical chart queries.", InputSchema: inputSchema[observability.OutdatedWorkloadsInput](nil), Annotations: readOnly("Read most outdated workloads")}, func(ctx context.Context, req *mcp.CallToolRequest, in observability.OutdatedWorkloadsInput) (*mcp.CallToolResult, *observability.OutdatedWorkloads, error) {
		id, err := requireIdentity(req, mapping)
		if err != nil {
			return nil, nil, err
		}
		out, err := history.OutdatedWorkloads(ctx, id, in)
		return nil, out, err
	})
	mcp.AddTool(s, &mcp.Tool{
		Name: "query_signal_history", Title: "Query current or historical signals",
		Description:  "Prometheus history of CVEs in running digests (cves), ServiceAccounts with broad RBAC (serviceaccounts) estimated upgrade effort (technical_debt) containers by version drift with a 0–1 score (drift), or distinct running image digests with Trivy/filesystem evidence (scan_coverage). Set current=true for a bounded instant query; otherwise use hours (1–2160) or days (1–90); the default history window is 90 days. Effort defaults to the server environment assumptions and counts one upgrade per outdated image, falling back to build age per buildAgeDaysPerUpgrade days; each workload counts its worst image.",
		InputSchema:  inputSchema[observability.SignalHistoryInput](nil),
		OutputSchema: schemaFor[*observability.SignalHistory](), Annotations: readOnly("Query security and effort history"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, in observability.SignalHistoryInput) (*mcp.CallToolResult, *observability.SignalHistory, error) {
		id, err := requireIdentity(req, mapping)
		if err != nil {
			return nil, nil, err
		}
		result, err := history.SignalHistory(ctx, id, in)
		return nil, result, err
	})
	mcp.AddTool(s, &mcp.Tool{
		Name: "query_drift_history", Title: "Query version drift history",
		Description:  "Version-drift samples from Prometheus at adaptive resolution, for the requested namespaces or the whole cluster: releases behind, version status, image creation time, check time and container count. Use workload/kind or image to scope detail views. Gaps are unknown.",
		InputSchema:  inputSchema[observability.DriftHistoryInput](nil),
		OutputSchema: schemaFor[*observability.DriftHistory](),
		Annotations:  readOnly("Query version drift history"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, in observability.DriftHistoryInput) (*mcp.CallToolResult, *observability.DriftHistory, error) {
		id, err := requireIdentity(req, mapping)
		if err != nil {
			return nil, nil, err
		}
		result, err := history.DriftHistory(ctx, id, in)
		return nil, result, err
	})
}
