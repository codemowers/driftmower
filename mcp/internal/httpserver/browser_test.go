package httpserver

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestBrowserOriginBoundary(t *testing.T) {
	h := browserOrigins(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(401) }), "https://mcp.example", []string{"https://dashboard.example"})
	for _, tc := range []struct {
		origin, method, header string
		status                 int
	}{
		{"https://dashboard.example", "POST", "authorization", 204},
		{"https://evil.example", "POST", "authorization", 403},
		{"null", "POST", "authorization", 403},
		{"https://dashboard.example", "PUT", "authorization", 403},
		{"https://dashboard.example", "POST", "x-untrusted", 403},
	} {
		r := httptest.NewRequest("OPTIONS", "/mcp", nil)
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("Access-Control-Request-Method", tc.method)
		r.Header.Set("Access-Control-Request-Headers", tc.header)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Errorf("%+v: got %d", tc, w.Code)
		}
	}
	r := httptest.NewRequest("POST", "/mcp", nil)
	r.Header.Set("Origin", "https://dashboard.example")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("CORS bypassed bearer authorization")
	}
}
