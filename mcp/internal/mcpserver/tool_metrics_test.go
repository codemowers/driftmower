package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"testing"

	"github.com/codemowers/driftmower/mcp/internal/metrics"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestToolResultSizeMatchesWireJSON(t *testing.T) {
	raw, _ := json.Marshal(map[string]any{"text": "<html>\u2028", "array": []any{1, true, nil}})
	for _, result := range []*mcp.CallToolResult{
		{}, {Content: []mcp.Content{}}, {IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: "failed"}}},
		{StructuredContent: json.RawMessage(raw), Content: []mcp.Content{&mcp.TextContent{Text: "\x00\b\f\n\r\t\"\\<>&\u2028\u2029 snow☃ \xff"}}},
		{Content: []mcp.Content{&mcp.TextContent{Text: "literal replacement rune: \ufffd"}}},
		{Content: []mcp.Content{&mcp.TextContent{Text: "\xff\xfe\xc0\xaf"}}},
		{StructuredContent: json.RawMessage(raw), Content: []mcp.Content{
			&mcp.TextContent{Text: "valid <>&\u2028"},
			&mcp.TextContent{Text: "invalid \xe2\x82 before ☃"},
		}},
		{StructuredContent: map[string]string{"fallback": "<&>"}},
		{Content: []mcp.Content{&mcp.ImageContent{MIMEType: "image/png", Data: []byte{1, 2, 3}}}},
	} {
		want, err := json.Marshal(result)
		if err != nil {
			t.Fatal(err)
		}
		got, err := toolResultSize(result)
		if err != nil || got != len(want) {
			t.Fatalf("size %d, want %d: %v JSON %s", got, len(want), err, want)
		}
	}
}

func TestToolHistogramsObserveSDKCalls(t *testing.T) {
	m := metrics.New()
	strictTools["metric_test"] = true
	t.Cleanup(func() { delete(strictTools, "metric_test") })
	s := New(Deps{Metrics: m, Logger: slog.New(slog.DiscardHandler)})
	mcp.AddTool(s, &mcp.Tool{Name: "metric_test", Description: "Test instrumentation"}, func(_ context.Context, _ *mcp.CallToolRequest, in struct{ Fail bool }) (*mcp.CallToolResult, map[string]string, error) {
		if in.Fail {
			return nil, nil, errors.New("expected failure")
		}
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "<&> response"}}}, map[string]string{"value": "result"}, nil
	})
	client := connectTo(t, s)
	for _, fail := range []bool{false, true} {
		if _, err := client.CallTool(context.Background(), &mcp.CallToolParams{Name: "metric_test", Arguments: map[string]any{"Fail": fail}}); err != nil {
			t.Fatal(err)
		}
	}
	_, _ = client.CallTool(context.Background(), &mcp.CallToolParams{Name: "untrusted_unknown_tool_123", Arguments: map[string]any{}})
	families, err := m.Registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, family := range families {
		if family.GetName() != "driftmower_mcp_tool_response_size_bytes" && family.GetName() != "driftmower_mcp_tool_duration_seconds" {
			continue
		}
		for _, metric := range family.Metric {
			name, outcome := "", ""
			for _, label := range metric.Label {
				if label.GetName() == "tool" {
					name = label.GetValue()
				}
				if label.GetName() == "outcome" {
					outcome = label.GetValue()
				}
			}
			if name != "other" && name != "metric_test" {
				t.Fatalf("unbounded tool label %q", name)
			}
			if metric.Histogram.GetSampleCount() != 1 || metric.Histogram.GetSampleSum() <= 0 {
				t.Fatalf("invalid observation %v", metric)
			}
			seen[family.GetName()+"/"+name+"/"+outcome] = true
		}
	}
	for _, key := range []string{"driftmower_mcp_tool_duration_seconds/metric_test/ok", "driftmower_mcp_tool_duration_seconds/metric_test/error", "driftmower_mcp_tool_duration_seconds/other/error", "driftmower_mcp_tool_response_size_bytes/metric_test/ok", "driftmower_mcp_tool_response_size_bytes/metric_test/error"} {
		if !seen[key] {
			t.Fatalf("missing histogram %s; got %v", key, seen)
		}
	}
}
