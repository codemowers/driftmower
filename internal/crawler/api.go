package crawler

import (
	"context"
	"errors"
	"github.com/codemowers/driftmower/internal/httpcache"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
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
	started := time.Now()
	w.Header().Set("Cache-Control", "no-store")
	if r.URL.Path != "/v1/sources" && r.URL.Path != "/v1/changes" && r.URL.Path != "/v1/images" {
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
		var denied *browserAuthorizationError
		if errors.As(err, &denied) {
			http.Error(w, http.StatusText(denied.status), denied.status)
			return
		}
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if !slices.Contains(a.Allowed, user) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if r.URL.Path == "/v1/images" {

		offset, limit := 0, 100
		var parseErr error
		if raw := r.URL.Query().Get("offset"); raw != "" {
			offset, parseErr = strconv.Atoi(raw)
		}
		if raw := r.URL.Query().Get("limit"); raw != "" && parseErr == nil {
			limit, parseErr = strconv.Atoi(raw)
		}
		if parseErr != nil {
			http.Error(w, "invalid image pagination", 400)
			return
		}
		out, err := a.Crawler.SourceImages(r.URL.Query().Get("url"), offset, limit)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}

		httpcache.Private(w.Header(), started, time.Now(), time.Time{}, 15*time.Second)

		httpcache.JSON(w, r, out)
		return
	}
	// The changes after a version, parsed from the stored release notes and
	// changelog at the time of asking.
	if r.URL.Path == "/v1/changes" {
		report, err := a.Crawler.Changes(r.URL.Query().Get("url"), r.URL.Query().Get("from"))
		switch {
		case errors.Is(err, errNotFound):
			http.Error(w, "source not crawled", http.StatusNotFound)
		case err != nil:
			http.Error(w, err.Error(), http.StatusBadRequest)
		default:

			httpcache.Private(w.Header(), started, time.Now(), time.Time{}, 15*time.Second)

			w.Header().Set("Content-Type", "application/json")

			httpcache.JSON(w, r, report)
		}
		return
	}

	reports := a.Crawler.Reports()
	if url := r.URL.Query().Get("url"); url != "" {
		reports = slices.DeleteFunc(reports, func(report SourceReport) bool { return report.URL != url })
	}
	remaining, reset := a.Crawler.fetch.RateLimit()
	mode := r.URL.Query().Get("summary")
	if mode == "true" || mode == "advisories" {
		for i := range reports {
			reports[i].Releases = nil
			reports[i].Changelog = nil
			if mode == "true" {
				reports[i].Advisories = nil
			}
			if latest := reports[i].Latest; latest != nil {
				copy := *latest
				copy.Notes = ""
				reports[i].Latest = &copy
			}
			for j := range reports[i].Deployed {
				if mode == "true" {
					reports[i].Deployed[j].Findings = nil
				}
				reports[i].Deployed[j].Status = VersionStatus(&reports[i], &reports[i].Deployed[j])
			}
		}
	}
	w.Header().Set("Content-Type", "application/json")

	httpcache.Private(w.Header(), started, time.Now(), time.Time{}, 15*time.Second)

	httpcache.JSON(w, r, map[string]any{
		"sources": reports,
		"github":  map[string]any{"remaining": remaining, "reset": reset},
		// Resources not served, so the crawler has no inventory to crawl.
		"missing": a.Crawler.Missing(),
	})
}
