package httpserver

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGzipCompressesJSONAndStreamsAndPassesEncodedBodies(t *testing.T) {
	handler := Gzip(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/json":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(strings.Repeat(`{"a":1}`, 100)))
		case "/stream":
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = w.Write([]byte("data: first\n\n"))
			w.(http.Flusher).Flush()
			_, _ = w.Write([]byte("data: second\n\n"))
		case "/sbom":
			w.Header().Set("Content-Type", "application/vnd.cyclonedx+json")
			w.Header().Set("Content-Encoding", "gzip")
			_, _ = w.Write([]byte("already compressed"))
		}
	}))
	get := func(path, accept string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Header.Set("Accept-Encoding", accept)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	for _, path := range []string{"/json", "/stream"} {
		w := get(path, "gzip, br")
		if w.Header().Get("Content-Encoding") != "gzip" {
			t.Fatalf("%s not compressed", path)
		}
		reader, err := gzip.NewReader(w.Body)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(reader)
		if path == "/stream" && string(body) != "data: first\n\ndata: second\n\n" {
			t.Fatalf("stream = %q", body)
		}
	}
	if w := get("/json", ""); w.Header().Get("Content-Encoding") != "" {
		t.Fatal("compressed for a client that did not ask")
	}
	if w := get("/sbom", "gzip"); w.Body.String() != "already compressed" {
		t.Fatal("an encoded body was compressed twice")
	}
}
