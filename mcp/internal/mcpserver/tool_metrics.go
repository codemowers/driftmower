package mcpserver

import (
	"context"
	"encoding/json"
	"time"
	"unicode/utf8"

	"github.com/codemowers/driftmower/mcp/internal/metrics"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func toolMetrics(m *metrics.Metrics) mcp.Middleware {
	return func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			if method != "tools/call" {
				return next(ctx, method, req)
			}
			start := time.Now()
			result, err := next(ctx, method, req)
			elapsed := time.Since(start).Seconds()
			name, outcome := "other", "error"
			if value, ok := result.(*mcp.CallToolResult); ok && value != nil && err == nil {
				if params, ok := req.GetParams().(*mcp.CallToolParamsRaw); ok {
					name = params.Name
				}
				if !value.IsError {
					outcome = "ok"
				}
				if size, err := toolResultSize(value); err == nil {
					m.ToolResponseSize.WithLabelValues(name, outcome).Observe(float64(size))
				}
			}
			m.ToolDuration.WithLabelValues(name, outcome).Observe(elapsed)
			return result, err
		}
	}
}

// Typed SDK tools already serialize structuredContent to compact, HTML-escaped
// JSON. Measure that buffer and escaped text lengths without allocating another
// full inventory/SBOM-sized response solely for instrumentation.
func toolResultSize(result *mcp.CallToolResult) (int, error) {
	copy := *result
	extra := 0
	if result.StructuredContent != nil {
		if raw, ok := result.StructuredContent.(json.RawMessage); ok {
			copy.StructuredContent = json.RawMessage("null")
			extra += len(raw) - 4
		} else {
			body, err := json.Marshal(result)
			return len(body), err
		}
	}
	if result.Content != nil {
		copy.Content = make([]mcp.Content, len(result.Content))
		for i, content := range result.Content {
			copy.Content[i] = content
		}
	}
	for i, content := range result.Content {
		text, ok := content.(*mcp.TextContent)
		// Let the SDK marshal malformed text: replacement-rune escaping differs
		// between Go versions, so the valid UTF-8 fast path cannot size it.
		if !ok || !utf8.ValidString(text.Text) {
			body, err := json.Marshal(result)
			return len(body), err
		}
		value := *text
		value.Text = ""
		copy.Content[i] = &value
		extra += escapedTextBytes(text.Text)
	}
	body, err := json.Marshal(&copy)
	return len(body) + extra, err
}

// Count bytes within the JSON string quotes for valid UTF-8 text.
// Malformed text is measured through the SDK marshaler in toolResultSize.
func escapedTextBytes(text string) int {
	n := 0
	for len(text) > 0 {
		b := text[0]
		if b < utf8.RuneSelf {
			switch b {
			case '"', '\\', '\b', '\f', '\n', '\r', '\t':
				n += 2
			case '<', '>', '&':
				n += 6
			default:
				if b < 0x20 {
					n += 6
				} else {
					n++
				}
			}
			text = text[1:]
			continue
		}
		r, size := utf8.DecodeRuneInString(text)
		if r == '\u2028' || r == '\u2029' {
			n += 6
		} else {
			n += size
		}
		text = text[size:]
	}
	return n
}
