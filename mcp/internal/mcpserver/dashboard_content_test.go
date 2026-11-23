package mcpserver

import (
	"context"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestDashboardSkipsTheJSONTextCopy(t *testing.T) {
	server := mcp.NewServer(&mcp.Implementation{Name: "t", Version: "test"}, nil)
	server.AddReceivingMiddleware(dashboardContent())
	mcp.AddTool(server, &mcp.Tool{Name: "data"}, func(context.Context, *mcp.CallToolRequest, struct{}) (*mcp.CallToolResult, map[string]any, error) {
		return nil, map[string]any{"rows": []int{1, 2, 3}}, nil
	})
	for name, wantCopy := range map[string]bool{dashboardClient: false, "agent": true} {
		serverTransport, clientTransport := mcp.NewInMemoryTransports()
		if _, err := server.Connect(context.Background(), serverTransport, nil); err != nil {
			t.Fatal(err)
		}
		session, err := mcp.NewClient(&mcp.Implementation{Name: name}, nil).Connect(context.Background(), clientTransport, nil)
		if err != nil {
			t.Fatal(err)
		}
		result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: "data"})
		if err != nil {
			t.Fatal(err)
		}
		text := result.Content[0].(*mcp.TextContent).Text
		if hasCopy := text != "Result in structuredContent."; hasCopy != wantCopy || result.StructuredContent == nil {
			t.Errorf("%s: text %q", name, text)
		}
		_ = session.Close()
	}
}
