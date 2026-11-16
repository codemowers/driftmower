package crawler

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSourceHTTPValidatorsTrackScrapeState(t *testing.T) {
	const source = "https://github.com/example/app"
	c := reportsCrawler(t, source, "1.0.0")
	c.state[source] = &sourceState{checkedAt: time.Now(), releases: []Release{{Tag: "1.1.0"}}}
	api := &API{Crawler: c, Allowed: []string{"public"}, Authenticate: func(context.Context, string) (string, error) { return "public", nil }}
	request := func(tag string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "/v1/sources?summary=true", nil)
		r.Header.Set("If-None-Match", tag)
		w := httptest.NewRecorder()
		api.ServeHTTP(w, r)
		return w
	}
	first := request("")
	tag := first.Header().Get("ETag")
	if first.Code != 200 || tag == "" || !strings.HasPrefix(first.Header().Get("Cache-Control"), "private,") {
		t.Fatal(first)
	}
	if w := request(tag); w.Code != 304 || w.Body.Len() != 0 {
		t.Fatalf("unchanged response: %d %s", w.Code, w.Body)
	}
	c.mu.Lock()
	c.activeSource = source
	c.mu.Unlock()
	if w := request(tag); w.Code != 200 || w.Header().Get("ETag") == tag {
		t.Fatal("scraping state did not invalidate response")
	}
}
