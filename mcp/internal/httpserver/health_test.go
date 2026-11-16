package httpserver

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/codemowers/driftmower/mcp/internal/metrics"
)

func TestHealthHandler(t *testing.T) {
	var ready atomic.Bool
	m := metrics.New()
	h := HealthHandler(&ready, m)

	serve := func(method, path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(method, path, nil))

		return rec
	}

	cases := []struct {
		method, path string
		ready        bool
		status       int
		body         string
	}{
		{"GET", "/healthz", false, 200, `{"status":"ok"}`},
		{"GET", "/readyz", false, 503, `{"status":"not_ready"}`},
		{"GET", "/startupz", false, 503, `{"status":"not_ready"}`},
		{"GET", "/readyz", true, 200, `{"status":"ok"}`},
		{"GET", "/startupz", true, 200, `{"status":"ok"}`},
		{"POST", "/healthz", true, 405, `{"error":"method_not_allowed"}`},
		{"GET", "/nope", true, 404, `{"error":"not_found"}`},
	}
	for _, tc := range cases {
		ready.Store(tc.ready)
		rec := serve(tc.method, tc.path)
		if rec.Code != tc.status || strings.TrimSpace(rec.Body.String()) != tc.body {
			t.Errorf("%s %s (ready=%v) = %d %s, want %d %s",
				tc.method, tc.path, tc.ready, rec.Code, rec.Body, tc.status, tc.body)
		}
	}

	m.Sessions.Inc()
	rec := serve("GET", "/metrics")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "driftmower_mcp_sessions_total 1") {
		t.Errorf("/metrics = %d %s", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), "go_goroutines") || !strings.Contains(rec.Body.String(), "go_memstats_heap_alloc_bytes") || !strings.Contains(rec.Body.String(), "process_resident_memory_bytes") {
		t.Error("/metrics is missing runtime and process memory collectors")
	}
}
