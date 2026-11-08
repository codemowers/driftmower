// driftmower-dashboard serves static browser assets and public configuration.
// It has no API proxy, session store, OAuth secret or Kubernetes credentials.
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func main() {
	root := os.Getenv("ASSET_DIR")
	if root == "" {
		root = "/app/public"
	}
	listen := os.Getenv("LISTEN_ADDR")
	if listen == "" {
		listen = "[::]:8080"
	}
	mux := http.NewServeMux()
	var clusters []struct {
		Name string `json:"name"`
		URL  string `json:"url"`
	}
	if raw := os.Getenv("MCP_ENDPOINTS"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &clusters); err != nil {
			log.Fatalf("MCP_ENDPOINTS: %v", err)
		}
	}
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("GET /dashboard-config.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]any{"mcpUrl": os.Getenv("MCP_URL"), "clusters": clusters})
	})
	files := http.FileServer(http.Dir(root))
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:*; frame-ancestors 'none'; base-uri 'self'")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		name := filepath.Join(root, filepath.Clean("/"+r.URL.Path))
		if info, err := os.Stat(name); err == nil && !info.IsDir() {
			files.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/_next/") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, filepath.Join(root, "index.html"))
	})
	server := &http.Server{Addr: listen, Handler: mux, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	log.Printf("Serving static dashboard on %s", listen)
	log.Fatal(server.ListenAndServe())
}
