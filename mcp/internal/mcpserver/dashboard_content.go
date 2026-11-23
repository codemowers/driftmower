package mcpserver

import (
	"bytes"
	"context"
	"encoding/json"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// dashboardClient is the name the browser dashboard initializes with.
const dashboardClient = "driftmower-dashboard"

// dashboardContent drops the SDK's serialized-JSON text fallback for the
// dashboard, which reads structuredContent only; agents keep the fallback
// because many clients show only text content.
func dashboardContent() mcp.Middleware {
	return func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			res, err := next(ctx, method, req)
			call, ok := req.(*mcp.CallToolRequest)
			result, isResult := res.(*mcp.CallToolResult)
			if err != nil || method != "tools/call" || !ok || !isResult || result.StructuredContent == nil {
				return res, err
			}
			if info := call.ClientInfo(); info == nil || info.Name != dashboardClient {
				return res, err
			}
			structured, mErr := json.Marshal(result.StructuredContent)
			if mErr != nil {
				return res, err
			}
			for i, c := range result.Content {
				if t, ok := c.(*mcp.TextContent); ok && bytes.Equal(bytes.TrimSpace([]byte(t.Text)), bytes.TrimSpace(structured)) {
					result.Content[i] = &mcp.TextContent{Text: "Result in structuredContent."}
				}
			}
			return res, err
		}
	}
}
