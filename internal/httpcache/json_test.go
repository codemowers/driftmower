package httpcache

import (
	"net/http/httptest"
	"testing"
)

func TestConditionalJSONValidatesRepresentationsAndDoesNotCacheErrors(t *testing.T) {
	request := func(method, tag string, value any) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "/catalog", nil)
		r.Header.Set("If-None-Match", tag)
		w := httptest.NewRecorder()
		w.Header().Set("Cache-Control", "public, max-age=30, must-revalidate")
		JSON(w, r, value)
		return w
	}
	first := request("GET", "", map[string]int{"version": 1})
	tag := first.Header().Get("ETag")
	if first.Code != 200 || tag == "" {
		t.Fatal(first)
	}
	for _, match := range []string{tag, "W/" + tag, `"another", ` + tag, "*"} {
		w := request("GET", match, map[string]int{"version": 1})
		if w.Code != 304 || w.Body.Len() != 0 || w.Header().Get("ETag") != tag {
			t.Fatalf("conditional result: %d %s", w.Code, w.Body)
		}
	}
	changed := request("GET", tag, map[string]int{"version": 2})
	if changed.Code != 200 || changed.Header().Get("ETag") == tag {
		t.Fatal("changed data was not invalidated")
	}
	if request("POST", tag, map[string]int{"version": 1}).Code != 200 {
		t.Fatal("POST was treated as a conditional GET")
	}
	invalid := request("GET", "", make(chan int))
	if invalid.Code != 500 || invalid.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("encoding error cached")
	}
}
