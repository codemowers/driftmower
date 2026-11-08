package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestUploadRetries(t *testing.T) {
	for _, tc := range []struct {
		name             string
		status, attempts int
		success          bool
	}{
		{"startup", 503, 3, true},
		{"unauthorized", 401, 1, false},
		{"unavailable", 503, 6, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				body, _ := io.ReadAll(r.Body)
				if string(body) != "sbom" || r.Header.Get("Authorization") != "Bearer token" || r.Method != "PUT" {
					t.Error("retry lost request data")
				}
				if tc.success && calls == tc.attempts {
					w.WriteHeader(201)
				} else {
					w.WriteHeader(tc.status)
				}
			}))
			defer server.Close()
			err := uploadArtifact(context.Background(), server.Client(), server.URL, "token", []byte("sbom"), 0)
			if (err == nil) != tc.success || calls != tc.attempts {
				t.Fatalf("calls=%d err=%v", calls, err)
			}
		})
	}
}
