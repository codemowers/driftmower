package crawler

import (
	_ "embed"
	"encoding/json"
	"net"
	"net/http"
)

//go:embed ui.html
var uiPage []byte

// UI serves a page for inspecting the crawler's cached data, and the data
// itself at /api/sources. It has no authentication: serve it only on a
// loopback address, reached through kubectl port-forward.
func (c *Crawler) UI() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'")
		w.Write(uiPage)
	})
	mux.HandleFunc("GET /api/sources", func(w http.ResponseWriter, _ *http.Request) {
		remaining, reset := c.fetch.RateLimit()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"sources": c.Reports(),
			"github":  map[string]any{"remaining": remaining, "reset": reset, "token": c.cfg.GitHubToken != ""},
			"synced":  c.Synced(),
		})
	})
	// Through a port-forward the page is reachable as localhost; refusing
	// other Host headers stops DNS rebinding from a site the viewer visits.
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.Host)
		if err != nil {
			host = r.Host
		}
		if host != "localhost" && host != "127.0.0.1" && host != "::1" {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		mux.ServeHTTP(w, r)
	})
}
