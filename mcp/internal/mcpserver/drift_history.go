package mcpserver

import (
	"context"
	"errors"
	"slices"

	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/observability"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func addDriftHistoryTool(s *mcp.Server, history *observability.Service, mapping auth.Mapping) {
	mcp.AddTool(s, &mcp.Tool{
		Name: "query_signal_history", Title: "Query security and effort history",
		Description:  "Evaluate retained facts in Prometheus for CVE findings in running image digests, distinct active ServiceAccounts with broad RBAC, or estimated upgrade effort. Signal is cves, serviceaccounts or technical_debt. Default window 90 days. Effort uses hoursPerUpgrade (default 1), with build-age fallback only for images without version comparison: one unit per buildAgeDaysPerUpgrade (default 365) days. Worst image effort per workload is counted once. Unknown version/build timestamps remain unknown. Assumptions apply retroactively to raw observations, never stored effort estimates. Omitted namespaces requires cluster-wide list pods; supplied namespaces are individually authorized.",
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
		Description:  "Query raw version-drift samples from this cluster's configured Prometheus. Requires list pods in the requested namespace. Metrics: driftmower_version_releases_behind (nonnegative, absent when unknown), driftmower_version_status (status and reason labels), driftmower_image_created_timestamp_seconds (OCI created label only; missing labels are absent), driftmower_version_checked_timestamp_seconds, driftmower_version_container_count. Samples are collected every five minutes; gaps are unknown. Effort estimates are never stored. Use query_signal_history for PromQL-evaluated security and retroactive effort charts with explicit assumptions. No historical database report snapshots.",
		InputSchema:  inputSchema[observability.MetricsInput](nil),
		OutputSchema: schemaFor[*observability.MetricsResult](),
		Annotations:  readOnly("Query version drift history"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, in observability.MetricsInput) (*mcp.CallToolResult, *observability.MetricsResult, error) {
		id, err := requireIdentity(req, mapping)
		if err != nil {
			return nil, nil, err
		}
		if !slices.Contains([]string{"driftmower_version_releases_behind", "driftmower_version_status", "driftmower_image_created_timestamp_seconds", "driftmower_version_checked_timestamp_seconds", "driftmower_version_container_count"}, in.Metric) {
			return nil, nil, errors.New("unsupported drift metric")
		}
		if in.StepSeconds == 0 {
			in.StepSeconds = 300
		}
		result, err := history.QueryMetrics(ctx, id, in)
		return nil, result, err
	})
}
