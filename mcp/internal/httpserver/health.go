// Package httpserver serves the MCP endpoint and the separate health port.
package httpserver

import (
	"encoding/json"
	"net/http"
	"sync/atomic"

	"github.com/codemowers/driftmower/mcp/internal/metrics"
)

// HealthHandler serves liveness, readiness, startup and metrics on the health
// port. Readiness and startup report ready only once ready is set.
func HealthHandler(ready *atomic.Bool, m *metrics.Metrics, drift ...http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", m.Handler())
	if len(drift) > 0 && drift[0] != nil {
		mux.Handle("GET /drift-metrics", drift[0])
	}
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	readiness := func(w http.ResponseWriter, _ *http.Request) {
		if ready.Load() {
			writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		} else {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready"})
		}
	}
	mux.HandleFunc("GET /readyz", readiness)
	mux.HandleFunc("GET /startupz", readiness)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})

			return
		}
		if _, pattern := mux.Handler(r); pattern == "" {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found"})

			return
		}
		mux.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
