// Package logging builds the process logger. Logs are JSON on stderr so stdout
// stays free for the stdio MCP transport.
package logging

import (
	"io"
	"log/slog"
)

// New returns a JSON logger writing records at level and above to w. level is
// one of debug, info, warn or error, as validated by the config package.
func New(w io.Writer, level string) *slog.Logger {
	var l slog.Level
	_ = l.UnmarshalText([]byte(level))

	return slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{Level: l}))
}
