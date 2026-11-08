package httpserver

import (
	"net/http"
	"net/url"
	"strings"
)

// browserOrigins handles public-client CORS and rejects unexpected Origins on
// MCP requests, including authenticated requests. Origin is not authorization.
func browserOrigins(next http.Handler, publicURL string, allowed []string) http.Handler {
	origins := map[string]bool{}
	if u, err := url.Parse(publicURL); err == nil {
		origins[u.Scheme+"://"+u.Host] = true
	}
	for _, origin := range allowed {
		origins[origin] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			w.Header().Add("Vary", "Origin")
			if !origins[origin] {
				http.Error(w, "origin is not allowed", http.StatusForbidden)
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Expose-Headers", "Mcp-Session-Id, MCP-Protocol-Version, WWW-Authenticate")
			if r.Method == http.MethodOptions {
				method := r.Header.Get("Access-Control-Request-Method")
				if method != "GET" && method != "POST" && method != "DELETE" {
					http.Error(w, "method is not allowed", http.StatusForbidden)
					return
				}
				for _, header := range strings.Split(r.Header.Get("Access-Control-Request-Headers"), ",") {
					switch strings.ToLower(strings.TrimSpace(header)) {
					case "", "authorization", "content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id":
					default:
						http.Error(w, "header is not allowed", http.StatusForbidden)
						return
					}
				}
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID")
				w.Header().Set("Access-Control-Max-Age", "600")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
