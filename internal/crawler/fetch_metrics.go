package crawler

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

type fetchMetrics struct {
	duration  *prometheus.HistogramVec
	requests  *prometheus.CounterVec
	downloads *prometheus.HistogramVec
}

func newFetchMetrics() *fetchMetrics {
	return &fetchMetrics{
		downloads: prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "driftmower_crawler_download_bytes", Help: "Upstream response body bytes as received, before decompression, by cache category, hostname and content encoding. Bodyless 304 responses count as zero; partial failed reads count bytes received. No URLs or credentials.", Buckets: []float64{0, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864}}, []string{"category", "hostname", "encoding"}),
		duration:  prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "driftmower_crawler_fetch_duration_seconds", Help: "Crawler fetch and decode duration including rate-limit waits; operations use bounded categories, never repository URLs.", Buckets: []float64{.01, .05, .1, .5, 1, 5, 15, 60, 300, 900}}, []string{"provider", "operation", "outcome"}),
		requests:  prometheus.NewCounterVec(prometheus.CounterOpts{Name: "driftmower_crawler_http_requests_total", Help: "Crawler upstream HTTP responses; status_code 0 indicates transport failure. A 304 reuses a retained conditional response body."}, []string{"provider", "operation", "status_code"}),
	}
}

func fetchLabels(raw string) (provider, operation string) {
	provider, operation = "other", "repository"
	u, err := url.Parse(raw)
	if err != nil {
		return
	}
	switch u.Hostname() {
	case "api.github.com", "raw.githubusercontent.com":
		provider = "github"
	case "gitlab.com":
		provider = "gitlab"
	case "codeberg.org", "gitea.com":
		provider = "gitea"
	case "endoflife.date":
		provider = "endoflife"
	case "api.osv.dev":
		provider = "osv"
	}
	if strings.HasPrefix(u.Path, "/api/v3/") || strings.HasSuffix(u.Hostname(), ".ghe.com") {
		provider = "github_enterprise"
	}
	path := u.Path
	switch {
	case u.Hostname() == "endoflife.date":
		operation = "endoflife"
	case strings.HasSuffix(path, "/license"):
		operation = "license"
	case strings.HasSuffix(path, "/v1/query"):
		operation = "osv"
	case strings.Contains(path, "/security-advisories"), strings.Contains(path, "/advisories"):
		operation = "ghsa"
	case strings.Contains(path, "/releases"):
		operation = "releases"
	case strings.Contains(path, "/tags"):
		operation = "tags"
	case u.Hostname() == "raw.githubusercontent.com", strings.Contains(path, "/contents"), strings.Contains(path, "/repository/tree"), strings.Contains(path, "/repository/files"):
		operation = "changelog"
	}
	return
}

func (f *fetcher) observeFetch(raw string) func(error) {
	start := time.Now()
	return func(err error) {
		if f.metrics == nil {
			return
		}
		outcome := "ok"
		switch {
		case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
			outcome = "canceled"
		case errors.Is(err, errNotFound):
			outcome = "not_found"
		case err != nil:
			outcome = "error"
		}
		provider, operation := fetchLabels(raw)
		f.metrics.duration.WithLabelValues(provider, operation, outcome).Observe(time.Since(start).Seconds())
	}
}

func (f *fetcher) observeHTTP(raw string, resp *http.Response) {
	if f.metrics == nil {
		return
	}
	status := 0
	if resp != nil {
		status = resp.StatusCode
	}
	provider, operation := fetchLabels(raw)
	f.metrics.requests.WithLabelValues(provider, operation, strconv.Itoa(status)).Inc()
}

func downloadHostname(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "unknown"
	}
	return strings.ToLower(u.Hostname())
}
func downloadEncoding(encoding string) string {
	switch encoding {
	case "gzip", "identity":
		return encoding
	default:
		return "other"
	}
}

func responseHostname(raw string, response *http.Response) string {
	if response.Request != nil && response.Request.URL != nil {
		return strings.ToLower(response.Request.URL.Hostname())
	}
	return downloadHostname(raw)
}
