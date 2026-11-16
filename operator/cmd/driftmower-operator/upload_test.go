package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/codemowers/driftmower/internal/scanner"
)

func TestUploadFileReportsOversizedArtifactWithoutSendingIt(t *testing.T) {
	output := filepath.Join(t.TempDir(), "sbom.json")
	file, err := os.Create(output)
	if err != nil {
		t.Fatal(err)
	}
	const size = scanner.MaxSBOMBytes + 123
	if err := file.Truncate(size); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != http.MethodPut || r.Header.Get("Authorization") != "Bearer token" || r.Header.Get("Content-Type") != scanner.OversizedSBOMMediaType {
			t.Errorf("incorrect size report request: %s %v", r.Method, r.Header)
		}
		var report scanner.SBOMSizeReport
		if r.ContentLength > 1024 || json.NewDecoder(r.Body).Decode(&report) != nil || report.SizeBytes != size {
			t.Errorf("expected a small report of %d bytes, got %+v", size, report)
		}
		w.WriteHeader(http.StatusRequestEntityTooLarge)
	}))
	defer server.Close()
	if err := uploadFile(context.Background(), server.Client(), server.URL, "token", output, 0); err == nil || calls != 1 {
		t.Fatalf("oversized upload must fail without retries: calls=%d, error=%v", calls, err)
	}
}

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
			err := uploadArtifact(context.Background(), server.Client(), server.URL, "token", "application/vnd.cyclonedx+json", []byte("sbom"), 0)
			if (err == nil) != tc.success || calls != tc.attempts {
				t.Fatalf("calls=%d err=%v", calls, err)
			}
		})
	}
}
