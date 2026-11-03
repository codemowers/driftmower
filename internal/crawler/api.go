package crawler

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
)

// API serves source reports to the callers it allows, authenticated by
// projected ServiceAccount token. Reports hold only public data, but they
// map the cluster's software, so only the callers listed in Allowed read them.
type API struct {
	Crawler *Crawler
	// Authenticate returns the username a bearer token belongs to.
	Authenticate func(ctx context.Context, token string) (string, error)
	// Allowed lists usernames such as
	// system:serviceaccount:driftmower:driftmower-mcp.
	Allowed []string
}

func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/v1/sources" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	token, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	user, err := a.Authenticate(r.Context(), token)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if !slices.Contains(a.Allowed, user) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	reports := a.Crawler.Reports()
	if url := r.URL.Query().Get("url"); url != "" {
		reports = slices.DeleteFunc(reports, func(report SourceReport) bool { return report.URL != url })
	}
	remaining, reset := a.Crawler.fetch.RateLimit()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"sources": reports,
		"github":  map[string]any{"remaining": remaining, "reset": reset},
	})
}
