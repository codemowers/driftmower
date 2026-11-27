package crawler

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/codemowers/driftmower/internal/gzipstore"
	"github.com/codemowers/driftmower/internal/lifecycle"
	"github.com/prometheus/client_golang/prometheus"
)

func TestPersistentGzipConditionalResponseAndMetric(t *testing.T) {
	payload := []byte(`{"ok":true}`)
	wire, err := gzipstore.Encode(payload)
	if err != nil {
		t.Fatal(err)
	}
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Header.Get("Accept-Encoding") != "gzip" {
			t.Error("gzip not requested")
		}
		if requests == 2 {
			if r.Header.Get("If-None-Match") != `"v1"` {
				t.Error("ETag lost across restart")
			}
			w.WriteHeader(304)
			return
		}
		w.Header().Set("ETag", `"v1"`)
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = w.Write(wire)
	}))
	defer server.Close()
	dir := t.TempDir()
	f := newFetcher(server.Client(), "private-token")
	f.cacheDir = dir
	raw := server.URL + "/repos/example/app/releases"
	if body, err := f.get(context.Background(), raw, false); err != nil || !bytes.Equal(body, payload) {
		t.Fatalf("fetch: %s %v", body, err)
	}
	onDisk, err := os.ReadFile(f.responsePath(raw))
	if err != nil || !bytes.Equal(onDisk, wire) {
		t.Fatal("upstream gzip was recompressed")
	}
	f2 := newFetcher(server.Client(), "private-token")
	f2.cacheDir = dir
	f2.metrics = f.metrics
	if body, err := f2.get(context.Background(), raw, false); err != nil || !bytes.Equal(body, payload) {
		t.Fatalf("304 after restart: %s %v", body, err)
	}
	onDisk, _ = os.ReadFile(f.responsePath(raw))
	if !bytes.Equal(onDisk, wire) {
		t.Fatal("304 rewrote response body")
	}
	f3 := newFetcher(server.Client(), "different-token")
	f3.cacheDir = dir
	if _, found, err := f3.diskResponse(raw, maxBody); err != nil || found {
		t.Fatal("credential scopes share private cache")
	}
	r := prometheus.NewRegistry()
	r.MustRegister(f.metrics.downloads)
	families, err := r.Gather()
	if err != nil {
		t.Fatal(err)
	}
	var samples uint64
	var sum float64
	for _, m := range families[0].Metric {
		for _, label := range m.Label {
			if label.GetName() == "hostname" && label.GetValue() != "127.0.0.1" {
				t.Fatal("hostname includes more than host")
			}
		}
		samples += m.Histogram.GetSampleCount()
		sum += m.Histogram.GetSampleSum()
	}
	if samples != 2 || sum != float64(len(wire)) {
		t.Fatalf("download histogram count=%d sum=%f", samples, sum)
	}
	// Refresh time, not original download time, controls restart TTL.
	cached, found, err := f.diskResponse(raw, maxBody)
	if err != nil || !found || time.Since(cached.checkedAt) > time.Minute {
		t.Fatal("304 validation time not persisted")
	}
}
func TestSourceEvidenceRestoresNotesChangelogAndAdvisories(t *testing.T) {
	c := &Crawler{cfg: Config{CacheDir: t.TempDir()}, fetch: newFetcher(http.DefaultClient, ""), log: slog.New(slog.DiscardHandler)}
	now := time.Now().UTC()
	state := &sourceState{checkedAt: now, due: now.Add(6 * time.Hour), releases: []Release{{Tag: "v1.0.0", Notes: "historic release"}}, changelog: &Changelog{Path: "CHANGELOG.md", Text: "# 1.0.0\n- fixed"}, advisories: []Advisory{{ID: "GHSA-example"}}, osv: map[string][]Advisory{"v1.0.0": {{ID: "CVE-example"}}}}
	source := "https://github.com/example/demo"
	if err := c.persistSource(source, state); err != nil {
		t.Fatal(err)
	}
	restored, err := c.restoreSource(source)
	if err != nil || restored == nil {
		t.Fatal(err)
	}
	if restored.changelog.Text != state.changelog.Text || restored.releases[0].Notes != "historic release" || restored.advisories[0].ID != "GHSA-example" || restored.osv["v1.0.0"][0].ID != "CVE-example" || !restored.due.Equal(state.due) {
		t.Fatalf("lost source evidence: %+v", restored)
	}
}
func TestLifecycleRulesReloadAndBadCatalogPreservesCache(t *testing.T) {
	dir := t.TempDir()
	rulesPath := filepath.Join(dir, "rules.json")
	if err := os.WriteFile(rulesPath, []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	c := &Crawler{cfg: Config{CacheDir: dir}, fetch: newFetcher(http.DefaultClient, ""), log: slog.New(slog.DiscardHandler)}
	if err := c.OpenLifecycle(rulesPath, 0); err != nil {
		t.Fatal(err)
	}
	if c.lifecycle.ttl != 14*24*time.Hour {
		t.Fatal("incorrect lifecycle TTL")
	}
	_ = c.lifecycle.decode([]byte(`{"result":[{"name":"demo","label":"Demo","identifiers":[{"type":"purl","id":"pkg:npm/demo"}],"tags":["framework"]}]}`))
	q := lifecycle.Query{PURL: "pkg:npm/demo"}
	if len(c.Lifecycles([]lifecycle.Query{q}).Matches) != 1 {
		t.Fatal("missing PURL anchor")
	}
	if err := os.WriteFile(rulesPath, []byte(`{"pkg:npm/demo":{"disabled":true}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if len(c.Lifecycles([]lifecycle.Query{q}).Matches) != 0 {
		t.Fatal("mounted rules not reloaded")
	}
	bad := []byte(`{"result":[]}`)
	c.lifecycle.fetch.client = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(bad))}, nil
	})}
	if _, err := c.lifecycle.fetch.get(context.Background(), lifecycleURL, false); err == nil {
		t.Fatal("empty catalog accepted")
	}
	if _, err := os.Stat(c.lifecycle.fetch.responsePath(lifecycleURL)); !os.IsNotExist(err) {
		t.Fatal("invalid response replaced last-good cache")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestCacheEvictionBoundsCompressedCategories(t *testing.T) {
	dir := t.TempDir()
	c := &Crawler{cfg: Config{CacheDir: dir, CacheMaxBytes: 1}}
	for _, category := range []string{"releases", "advisories", "endoflife"} {
		body, _ := json.Marshal(map[string]string{"payload": category})
		if err := gzipstore.Write(filepath.Join(dir, category, cacheID(category)+".json.gz"), body); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.pruneCache(); err != nil {
		t.Fatal(err)
	}
	for _, category := range []string{"releases", "advisories", "endoflife"} {
		entries, _ := os.ReadDir(filepath.Join(dir, category))
		if len(entries) != 0 {
			t.Fatal("cache limit not enforced")
		}
	}
}

func TestPlainResponseCompressedLocallyAndCorruptGzipRejected(t *testing.T) {
	payload := []byte(`{"plain":true}`)
	f := newFetcher(http.DefaultClient, "")
	f.cacheDir = t.TempDir()
	response := &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(payload))}
	body, compressed, err := f.responseBody("https://example.com/releases", response)
	if err != nil || !bytes.Equal(body, payload) {
		t.Fatal(err)
	}
	decoded, err := gzipstore.Decode(compressed, maxBody)
	if err != nil || !bytes.Equal(decoded, payload) {
		t.Fatal("plain response not compressed", err)
	}
	compressed[len(compressed)-1] ^= 1
	response = &http.Response{StatusCode: 200, Header: http.Header{"Content-Encoding": []string{"gzip"}}, Body: io.NopCloser(bytes.NewReader(compressed))}
	if _, _, err = f.responseBody("https://example.com/releases", response); err == nil {
		t.Fatal("corrupted gzip accepted")
	}
}
