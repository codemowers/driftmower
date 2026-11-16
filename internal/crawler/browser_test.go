package crawler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestBrowserDirectReportsAuthorizeAndDoNotMutateStoredNotes(t *testing.T) {
	const url = "https://github.com/example/app"
	c := reportsCrawler(t, url, "1.0.0")
	c.state[url] = &sourceState{checkedAt: time.Now(), releases: []Release{{Tag: "1.1.0", Notes: "long release notes"}}}
	authorizations := 0
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorizations++
		if r.Header.Get("Authorization") != "Bearer valid" {
			w.WriteHeader(403)
			return
		}
		w.WriteHeader(204)
	}))
	defer auth.Close()
	h := BrowserAPI(c, auth.URL, []string{"http://localhost:8080"})
	for _, tc := range []struct {
		origin, token string
		status        int
	}{
		{"https://unexpected.example", "valid", 403},
		{"http://localhost:8080", "invalid", 403},
		{"http://localhost:8080", "valid", 200},
	} {
		r := httptest.NewRequest("GET", "/v1/sources?summary=true", nil)
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("Authorization", "Bearer "+tc.token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("status %d: %s", w.Code, w.Body)
		}
		if w.Code != 200 && w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("cached authorization error")
		}
		if w.Code == 200 && (!strings.Contains(w.Header().Get("Cache-Control"), "private") || strings.Contains(w.Body.String(), "long release notes") || !strings.Contains(w.Body.String(), "minor_behind")) {
			t.Fatalf("summary: %s %s", w.Header(), w.Body)
		}
	}
	if authorizations != 2 {
		t.Fatalf("authorization calls %d", authorizations)
	}
	if c.state[url].releases[0].Notes != "long release notes" {
		t.Fatal("summary mutated crawler cache")
	}
}
