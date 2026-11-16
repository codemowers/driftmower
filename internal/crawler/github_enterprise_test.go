package crawler

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestGitHubAndEnterpriseCredentialsAndRateLimitsStaySeparate(t *testing.T) {
	seen := map[string]string{}
	transport := sourceTransport(func(r *http.Request) (*http.Response, error) {
		seen[r.URL.Host] = r.Header.Get("Authorization")
		headers := http.Header{}
		if r.URL.Host == "github.company.test" {
			headers.Set("X-RateLimit-Remaining", "0")
			headers.Set("X-RateLimit-Reset", "4102444800")
		}
		return &http.Response{StatusCode: 200, Header: headers, Body: io.NopCloser(strings.NewReader(`[{"tag_name":"1.0.0"}]`)), Request: r}, nil
	})
	public := newFetcher(&http.Client{Transport: transport}, "public-test-token")
	enterprise := newFetcher(&http.Client{Transport: transport}, "enterprise-test-token")
	enterprise.githubBase = "https://github.company.test/api/v3"
	c := &Crawler{fetch: public, enterprise: map[string]*fetcher{"github.company.test": enterprise}}
	loc, ok := c.locate("https://github.company.test/team/app")
	if !ok || loc.forge != GitHub {
		t.Fatal("enterprise repository not recognized", loc)
	}
	if _, err := c.releases(context.Background(), loc); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	gh, _ := c.locate("https://github.com/team/app")
	if _, err := c.releases(ctx, gh); err != nil {
		t.Fatal("enterprise throttle affected github.com", err)
	}
	if seen["api.github.com"] != "Bearer public-test-token" || seen["github.company.test"] != "Bearer enterprise-test-token" {
		t.Fatalf("tokens crossed hosts: %v", seen)
	}
	if _, err := enterprise.getRaw(context.Background(), "https://unrelated.test/file"); err != nil {
		t.Fatal(err)
	}
	if seen["unrelated.test"] != "" {
		t.Fatal("enterprise token sent outside its API host")
	}
}

func TestEnterpriseServerAndCloudAPIAddresses(t *testing.T) {
	if got := enterpriseAPI("github.company.test"); got != "https://github.company.test/api/v3" {
		t.Fatal(got)
	}
	if got := enterpriseAPI("company.ghe.com"); got != "https://api.company.ghe.com" {
		t.Fatal(got)
	}
}
