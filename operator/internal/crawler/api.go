package crawler

import (
	"encoding/json"
	"net/http"
	"slices"
	"strings"

	"github.com/codemowers/driftmower/operator/internal/authz"
)

// API serves source reports to the callers it allows, authenticated by
// projected ServiceAccount token. Reports hold only public data, but they
// map the cluster's software, so the operator alone reads them.
type API struct {
	Crawler    *Crawler
	Authorizer *authz.Authorizer
	// Allowed lists usernames such as
	// system:serviceaccount:driftmower:driftmower-operator.
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
	id, err := a.Authorizer.Authenticate(r.Context(), token)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if !slices.Contains(a.Allowed, id.User) {
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
