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
		Name: "query_drift_history", Title: "Query version drift history",
		Description:  "Query raw version-drift samples from this cluster's dedicated Prometheus. Requires list pods in the requested namespace. Metrics: driftmower_version_releases_behind (nonnegative, absent when unknown), driftmower_version_status (status and reason labels), driftmower_image_created_timestamp_seconds (OCI created label only; missing labels are absent), driftmower_version_checked_timestamp_seconds, driftmower_version_container_count. Samples are collected every five minutes; gaps are unknown. Hours and dollar estimates are calculated by clients, never stored in metrics. Use raw observations and explicit assumptions. No historical database report snapshots.",
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
