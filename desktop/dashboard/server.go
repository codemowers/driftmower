package dashboard

import (
	"context"
	"encoding/json"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path"
	"strings"
	"time"
)

// Handler serves the static dashboard, its public configuration and, when
// KubeLogin is set, Kubernetes sign-in. It has no API proxy, session store,
// OAuth secret or Kubernetes credentials of its own.
func (d *Dashboard) Handler() http.Handler {
	assets := d.cfg.AssetFS
	if assets == nil {
		assets = os.DirFS(d.cfg.AssetDir)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("GET /dashboard-config.json", func(w http.ResponseWriter, _ *http.Request) {
		d.lastSeen.Store(time.Now().Unix())
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		data, err := d.GetConfigJSON()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		_, _ = w.Write(data)
	})
	if d.cfg.KubeLogin {
		mux.HandleFunc("GET /api/desktop/events", d.configEvents)
	}
	if d.cfg.KubeLogin {
		mux.HandleFunc("POST /api/kubernetes-sign-in", d.signIn)
		mux.HandleFunc("POST /api/desktop/retry", d.retryConnection)
	}
	if d.cfg.KubeLogin && d.cfg.ChromeProfiles != nil {
		mux.HandleFunc("POST /api/desktop/chrome-profile", d.setChromeProfile)
		mux.HandleFunc("POST /api/desktop/connect", d.openChromeConnection)
	}
	files := http.FileServer(http.FS(assets))
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:*; frame-ancestors 'none'; base-uri 'self'")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if info, err := fs.Stat(assets, name); err == nil && !info.IsDir() {
			files.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/_next/") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFileFS(w, r, assets, "index.html")
	})

	return mux
}

// LastSeen tracks active config streams and the most recent config request.
func (d *Dashboard) LastSeen() time.Time {
	if d.discovery.hasConfigClients() {
		return time.Now()
	}
	if s := d.lastSeen.Load(); s != 0 {
		return time.Unix(s, 0)
	}

	return time.Time{}
}

// sameOriginLoopback admits only the dashboard's own page: a loopback Host
// (no DNS-rebound name), a matching Origin, and a JSON body, which other
// sites cannot send without a CORS preflight this server never answers.
func sameOriginLoopback(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.Host)
	if err != nil {
		return false
	}
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return false
	}

	return r.Header.Get("Origin") == "http://"+r.Host && strings.HasPrefix(r.Header.Get("Content-Type"), "application/json")
}

func (d *Dashboard) signIn(w http.ResponseWriter, r *http.Request) {
	if !sameOriginLoopback(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var body struct {
		Context string `json:"context"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil || body.Context == "" {
		http.Error(w, "context required", http.StatusBadRequest)
		return
	}
	// Detached from the request: leaving the page must not kill kubelogin
	// while the person is signing in.
	if err := d.discovery.SignIn(context.WithoutCancel(r.Context()), body.Context); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
