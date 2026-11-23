package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"github.com/codemowers/driftmower/internal/imageanalysis"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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
			err := uploadArtifact(context.Background(), server.Client(), server.URL, "token", "application/vnd.cyclonedx+json", "", []byte("sbom"), 0)
			if (err == nil) != tc.success || calls != tc.attempts {
				t.Fatalf("calls=%d err=%v", calls, err)
			}
		})
	}
}

func TestUploadFileCompressesOnceAtSourceAndReusesBytesForRetries(t *testing.T) {
	output := filepath.Join(t.TempDir(), "sbom.json")
	body := []byte(`{"bomFormat":"CycloneDX","note":"` + strings.Repeat("a", 10000) + `"}`)
	if err := os.WriteFile(output, body, 0600); err != nil {
		t.Fatal(err)
	}
	calls := 0
	var first []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		encoded, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			return
		}
		if r.Header.Get("Content-Encoding") != "gzip" || len(encoded) >= len(body) {
			t.Error("source did not compress upload")
		}
		if calls == 1 {
			first = bytes.Clone(encoded)
		} else if !bytes.Equal(encoded, first) {
			t.Error("retry recompressed or changed artifact")
		}
		reader, err := gzip.NewReader(bytes.NewReader(encoded))
		if err != nil {
			t.Error(err)
			return
		}
		decoded, err := io.ReadAll(reader)
		if closeErr := reader.Close(); closeErr != nil {
			t.Error(closeErr)
		}
		if err != nil || !bytes.Equal(decoded, body) {
			t.Error("upload changed SBOM")
		}
		if calls < 3 {
			w.WriteHeader(503)
		} else {
			w.WriteHeader(201)
		}
	}))
	defer server.Close()
	if err := uploadFile(context.Background(), server.Client(), server.URL, "token", output, 0); err != nil {
		t.Fatal(err)
	}
	if calls != 3 {
		t.Fatalf("attempts %d", calls)
	}
}

func TestUploaderMergesFilesystemEvidenceIntoCycloneDXWithoutChangingSBOMCreationTime(t *testing.T) {
	dir := t.TempDir()
	output := filepath.Join(dir, "sbom.json")
	if err := os.WriteFile(output, []byte(`{"bomFormat":"CycloneDX","specVersion":"1.6","version":1,"metadata":{"timestamp":"2026-11-20T01:00:00Z"},"components":[{"type":"library","name":"retained","bom-ref":"package"}],"dependencies":[{"ref":"package","dependsOn":[]}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "db-metadata.json"), []byte(`{"UpdatedAt":"2026-11-19T00:00:00Z"}`), 0600); err != nil {
		t.Fatal(err)
	}
	modified := time.Date(2018, 9, 28, 17, 5, 8, 0, time.UTC)
	report := imageanalysis.Report{SchemaVersion: 1, NewestFileLimit: 1000, ObservedAt: "2026-11-20T00:00:00Z", Files: 1, Entries: 1, LatestFileModifiedAt: &modified, LatestFilePath: "/server", NewestFiles: []imageanalysis.File{{Path: "/server", ModifiedAt: modified, Size: 123, MIME: "application/octet-stream"}}, Binaries: []imageanalysis.Binary{{Path: "/server", Linking: "static"}}}
	f, err := os.Create(filepath.Join(dir, "analysis.json.gz"))
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(f)
	if err := json.NewEncoder(gz).Encode(report); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	f.Close()
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		reader, err := gzip.NewReader(r.Body)
		if err != nil {
			t.Error(err)
			return
		}
		defer reader.Close()
		body, err := io.ReadAll(reader)
		if err != nil {
			t.Error(err)
			return
		}
		decoded, err := imageanalysis.ReadCycloneDX(bytes.NewReader(body))
		if err != nil || len(decoded.Binaries) != 1 || decoded.LatestFilePath != "/server" {
			t.Errorf("filesystem facts lost: %+v %v", decoded, err)
		}
		var bom struct {
			Metadata struct {
				Timestamp string `json:"timestamp"`
			} `json:"metadata"`
			Properties []scanner.ScanProperty `json:"properties"`
			Components []json.RawMessage      `json:"components"`
		}
		if err := json.Unmarshal(body, &bom); err != nil {
			t.Error(err)
		}
		if bom.Metadata.Timestamp != "2026-11-20T01:00:00Z" || len(bom.Components) != 2 {
			t.Error("changed BOM creation time or original component")
		}
		coverage, _, db := scanner.ScanCoverage(bom.Properties)
		if coverage != "complete" || db != "2026-11-19T00:00:00Z" {
			t.Error("coverage/DB provenance lost")
		}
		for _, p := range bom.Properties {
			if !strings.HasPrefix(p.Name, "driftmower:") {
				t.Errorf("unprefixed extension %s", p.Name)
			}
			if p.Name == "driftmower:filesystem:latest-modified-path" {
				t.Error("duplicate top-level path")
			}
		}
		w.WriteHeader(201)
	}))
	defer server.Close()
	if err := uploadFile(context.Background(), server.Client(), server.URL, "token", output, 0); err != nil || calls != 1 {
		t.Fatalf("merged upload: calls=%d error=%v", calls, err)
	}
}

func TestAnalysisHandoffIsReadableByNonRootUploader(t *testing.T) {
	path := filepath.Join(t.TempDir(), "analysis.json.gz")
	body := []byte("filesystem observations")
	if err := writeAnalysisHandoff(path, body); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0004 == 0 {
		t.Fatalf("root-owned analysis report cannot be read by uploader: %o", info.Mode().Perm())
	}
	if info.Mode().Perm()&0022 != 0 {
		t.Fatal("analysis report must not be writable by other users")
	}
	got, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(got, body) {
		t.Fatal("handoff report changed", err)
	}
}
