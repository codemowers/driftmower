package mcpserver

import (
	"context"
	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/observability"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func addImageScanStatusesTool(s *mcp.Server, o *observability.Service, mapping auth.Mapping) {
	type input struct {
		Digests []string `json:"digests" jsonschema:"1 to 100 immutable sha256 image digests"`
	}
	mcp.AddTool(s, &mcp.Tool{Name: "get_image_scan_statuses", Title: "Get Trivy scan statuses", Description: "Query Prometheus for current Trivy scan states for up to 100 image digests. Returns pending, running, failed (retry budget exhausted), done (usable current artifact), partial or unavailable, with platform counts. Missing or stale metrics are unavailable, never pending. Reflects scrape/rule evaluation latency. No SBOMs are fetched. Requires list ContainerImages.", InputSchema: inputSchema[input](nil), OutputSchema: schemaFor[*observability.ImageScanStatuses](), Annotations: readOnly("Get Trivy scan statuses")}, func(ctx context.Context, req *mcp.CallToolRequest, in input) (*mcp.CallToolResult, *observability.ImageScanStatuses, error) {
		id, err := callerIdentity(req, mapping)
		if err != nil {
			return nil, nil, err
		}
		out, err := o.ImageScanStatuses(ctx, id, in.Digests)
		return nil, out, err
	})
}
