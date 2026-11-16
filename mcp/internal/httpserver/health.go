// Package httpserver serves the MCP endpoint and the separate health port.
package httpserver

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/pprof"
	"sync/atomic"

	"github.com/codemowers/driftmower/mcp/internal/metrics"
)

// HealthHandler serves liveness, readiness, startup and metrics on the health
// port. Readiness and startup report ready only once ready is set.
func HealthHandler(ready *atomic.Bool, m *metrics.Metrics) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", m.Handler())
	for _, name := range []string{"heap", "allocs", "goroutine"} {
		mux.Handle("GET /debug/pprof/"+name, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			host, _, err := net.SplitHostPort(r.RemoteAddr)
			if err != nil || !net.ParseIP(host).IsLoopback() {
				http.Error(w, "profiles require a local port-forward", http.StatusForbidden)
				return
			}
			w.Header().Set("Cache-Control", "no-store")
			pprof.Handler(name).ServeHTTP(w, r)
		}))
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
