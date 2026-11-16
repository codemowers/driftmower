package registry

import (
	"context"
	"net/http/httptest"
	"testing"
)

func TestCatalogETagChangesOnlyWithDataAndErrorsAreNotCached(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	handler := (&API{Store: store, Allowed: []string{"reader"}, Authenticate: func(context.Context, string) (string, error) { return "reader", nil }}).Handler()
	request := func(path, tag string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("If-None-Match", tag)
		r.Header.Set("Authorization", "Bearer test-reader")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	first := request("/v1/repositories", "")
	tag := first.Header().Get("ETag")
	if first.Code != 200 || tag == "" {
		t.Fatalf("initial response: %d %s", first.Code, first.Body)
	}
	if w := request("/v1/repositories", tag); w.Code != 304 {
		t.Fatalf("unchanged catalog invalidated: %d %s", w.Code, w.Body)
	}
	store.Configure([]RepositoryConfig{{Repository: "docker.io/library/alpine", TagPattern: ".*"}})
	if w := request("/v1/repositories", tag); w.Code != 200 || w.Header().Get("ETag") == tag {
		t.Fatal("catalog update not reflected")
	}
	for _, path := range []string{"/v1/repository?limit=-1", "/v1/configs/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"} {
		w := request(path, "")
		if w.Code < 400 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("cached error: %s %d %s", path, w.Code, w.Header())
		}
	}
	private := (&API{Store: store}).Handler()
	r := httptest.NewRequest("GET", "/v1/repositories", nil)
	r.Header.Set("If-None-Match", tag)
	w := httptest.NewRecorder()
	private.ServeHTTP(w, r)
	if w.Code != 401 || w.Header().Get("ETag") != "" {
		t.Fatal("validator bypassed authorization")
	}
}
