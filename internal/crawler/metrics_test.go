package crawler

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestFetchMetricsAndRetainedBodies(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 2 {
			if r.Header.Get("If-None-Match") != `"v1"` {
				t.Error("missing conditional request")
			}
			w.WriteHeader(http.StatusNotModified)
			return
		}
		if calls == 3 {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Header().Set("ETag", `"v1"`)
		fmt.Fprint(w, `{"ok":true}`)
	}))
	defer server.Close()
	f := newFetcher(server.Client(), "")
	for i := 0; i < 3; i++ {
		var out map[string]bool
		err := f.getJSON(context.Background(), server.URL+"/repos/private/security-advisories", &out)
		if (i == 2) != (err != nil) {
			t.Fatalf("fetch %d: %v", i, err)
		}
		if i < 2 && !out["ok"] {
			t.Fatal("304 lost cached body")
		}
	}
	for _, status := range []string{"200", "304", "403"} {
		if testutil.ToFloat64(f.metrics.requests.WithLabelValues("other", "ghsa", status)) != 1 {
			t.Fatalf("missing status %s", status)
		}
	}
	r := prometheus.NewRegistry()
	r.MustRegister(&crawlerFootprintCollector{&Crawler{fetch: f, state: map[string]*sourceState{
		"secret-repo": {releases: []Release{{Notes: "notes"}}, changelog: &Changelog{Text: "changes"}},
	}}})
	families, err := r.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, family := range families {
		for _, metric := range family.Metric {
			for _, label := range metric.Label {
				if strings.Contains(label.GetValue(), "secret") || strings.Contains(label.GetValue(), server.URL) {
					t.Fatal("repository identity leaked into labels")
				}
				if family.GetName() == "driftmower_crawler_retained_payload_bytes" && label.GetValue() == "http_cache_bodies" && metric.GetGauge().GetValue() != 11 {
					t.Fatal("wrong retained body size")
				}
			}
		}
	}
}

func TestFetchLabels(t *testing.T) {
	for _, tc := range []struct{ url, provider, operation string }{
		{"https://api.github.com/repos/acme/private/security-advisories", "github", "ghsa"},
		{"https://api.github.com/advisories?per_page=100", "github", "ghsa"},
		{"https://api.github.com/repos/acme/private/contents/", "github", "changelog"},
		{"https://raw.githubusercontent.com/acme/private/main/NEWS", "github", "changelog"},
		{"https://api.osv.dev/v1/query", "osv", "osv"},
	} {
		p, o := fetchLabels(tc.url)
		if p != tc.provider || o != tc.operation {
			t.Fatalf("%s: %s/%s", tc.url, p, o)
		}
	}
}
