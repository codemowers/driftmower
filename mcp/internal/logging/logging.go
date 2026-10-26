// Package logging builds the process logger. Logs are JSON on stderr so stdout
// stays free for the stdio MCP transport.
package logging

import (
	"context"
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

// AtLeast returns a logger that drops records below level, for libraries that
// log routine events at info.
func AtLeast(logger *slog.Logger, level slog.Level) *slog.Logger {
	return slog.New(minLevel{Handler: logger.Handler(), level: level})
}

type minLevel struct {
	slog.Handler
	level slog.Level
}

func (h minLevel) Enabled(ctx context.Context, l slog.Level) bool {
	return l >= h.level && h.Handler.Enabled(ctx, l)
}

func (h minLevel) WithAttrs(attrs []slog.Attr) slog.Handler {
	return minLevel{Handler: h.Handler.WithAttrs(attrs), level: h.level}
}

func (h minLevel) WithGroup(name string) slog.Handler {
	return minLevel{Handler: h.Handler.WithGroup(name), level: h.level}
}
