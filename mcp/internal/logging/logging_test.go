package logging

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

func TestAtLeast(t *testing.T) {
	var buf bytes.Buffer
	l := AtLeast(New(&buf, "debug"), slog.LevelWarn).With("component", "sdk")
	l.Info("session connected")
	l.Warn("session failed")
	if out := buf.String(); strings.Contains(out, "session connected") || !strings.Contains(out, `"component":"sdk"`) {
		t.Errorf("output = %s", out)
	}
}
