package crawler

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestSourceAccessStatus(t *testing.T) {
	for _, tc := range []struct {
		name         string
		status       int
		headers      http.Header
		body         string
		unauthorized bool
	}{
		{"hidden private repository", 404, nil, `{}`, true},
		{"invalid token", 401, nil, `{}`, true},
		{"insufficient permission", 403, nil, `{}`, true},
		{"primary rate limit", 403, http.Header{"X-Ratelimit-Remaining": {"0"}}, `{}`, false},
		{"retry after", 403, http.Header{"Retry-After": {"60"}}, `{}`, false},
		{"secondary rate limit", 403, nil, `{"message":"You have exceeded a secondary rate limit."}`, false},
		{"upstream outage", 500, nil, `{}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const source = "https://github.com/example/private"
			c := reportsCrawler(t, source)
			allowed := false
			c.fetch = newFetcher(&http.Client{Transport: sourceTransport(func(r *http.Request) (*http.Response, error) {
				if r.Header.Get("Authorization") != "Bearer test-token" {
					t.Fatal("crawler credentials missing")
				}
				status, body, headers := tc.status, tc.body, tc.headers.Clone()
				if allowed {
					status, body, headers = 200, `[]`, make(http.Header)
					// A readable repository can lack both optional files.
					if strings.HasSuffix(r.URL.Path, "/license") || strings.Contains(r.URL.Path, "/contents/") {
						status, body = 404, `{}`
					}
				}
				return &http.Response{StatusCode: status, Header: headers, Body: io.NopCloser(strings.NewReader(body))}, nil
			})}, "test-token")
			c.crawl(context.Background(), source)
			report := c.Reports()[0]
			if report.Unauthorized != tc.unauthorized || len(report.Errors) == 0 {
				t.Fatalf("wrong access state: %+v", report)
			}
			if tc.name == "hidden private repository" && !strings.Contains(strings.Join(report.Errors, " "), "not found or inaccessible") {
				t.Fatal("404 ambiguity lost")
			}
			evidence := c.CrawledSources(source)
			if len(evidence) != 1 || evidence[0].Unauthorized != tc.unauthorized {
				t.Fatalf("MCP evidence lost access state: %+v", evidence)
			}
			// The flag describes the latest attempt and clears after access returns.
			allowed = true
			c.crawl(context.Background(), source)
			report = c.Reports()[0]
			if report.Unauthorized || len(report.Errors) != 0 {
				t.Fatalf("successful crawl retained old access failure or treated optional 404 as unauthorized: %+v", report)
			}
		})
	}
}
