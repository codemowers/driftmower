package mcpserver

import (
	"context"
	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/observability"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func addImageScanStatusesTool(s *mcp.Server, o *observability.Service, mapping auth.Mapping) {
	type input struct {
		Digests []string `json:"digests" jsonschema:"Immutable sha256 image digests"`
	}
	mcp.AddTool(s, &mcp.Tool{Name: "get_image_scan_statuses", Title: "Get Trivy scan statuses", Description: "Trivy scan state (pending, running, failed, done, partial, unavailable) for image digests.", InputSchema: inputSchema[input](nil), OutputSchema: schemaFor[*observability.ImageScanStatuses](), Annotations: readOnly("Get Trivy scan statuses")}, func(ctx context.Context, req *mcp.CallToolRequest, in input) (*mcp.CallToolResult, *observability.ImageScanStatuses, error) {
		id, err := callerIdentity(req, mapping)
		if err != nil {
			return nil, nil, err
		}
		out, err := o.ImageScanStatuses(ctx, id, in.Digests)
		return nil, out, err
	})
}
