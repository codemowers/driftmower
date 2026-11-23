package registry

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"
)

func jsonBytes(t *testing.T, value any) []byte {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return body
}
func testStore(t *testing.T) *Store {
	t.Helper()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return store
}
func testLayer(name string) Layer {
	return Layer{Digest: sha256Digest([]byte("compressed-" + name)), DiffID: sha256Digest([]byte(name)), Size: 123}
}

func TestHierarchyPreservesEveryBoundaryAlternativesAndPlatforms(t *testing.T) {
	store := testStore(t)
	l1, l2, l3 := testLayer("alpine"), testLayer("python"), testLayer("app")
	platform := Platform{OS: "linux", Architecture: "arm64", Variant: "v8"}
	for _, image := range []Image{
		{Repository: "docker.io/library/alpine", Digest: sha256Digest([]byte("alpine")), Tags: []string{"3.21.3"}, Platform: platform, Layers: []Layer{l1}},
		{Repository: "docker.io/library/python", Digest: sha256Digest([]byte("python")), Tags: []string{"3.13.5-alpine3.21"}, Platform: platform, Layers: []Layer{l1, l2}},
		{Repository: "example.org/alternative/python", Digest: sha256Digest([]byte("alternative")), Tags: []string{"1.2.3"}, Platform: platform, Layers: []Layer{l1, l2}},
		{Repository: "example.org/wrong/order", Digest: sha256Digest([]byte("reversed")), Platform: platform, Layers: []Layer{l2, l1}},
		{Repository: "example.org/wrong/architecture", Digest: sha256Digest([]byte("amd64")), Platform: Platform{OS: "linux", Architecture: "amd64"}, Layers: []Layer{l1}},
		{Repository: "example.org/wrong/variant", Digest: sha256Digest([]byte("v9")), Platform: Platform{OS: "linux", Architecture: "arm64", Variant: "v9"}, Layers: []Layer{l1}},
	} {
		if err := store.Put(&Repository{Repository: image.Repository, Images: []Image{image}}); err != nil {
			t.Fatal(err)
		}
	}
	// Recompression changes registry blob digests, not filesystem DiffIDs.
	recompressed := l1
	recompressed.Digest = sha256Digest([]byte("different compression"))
	target := Target{Digest: sha256Digest([]byte("my image")), Platform: platform, Layers: []Layer{recompressed, l2, l3}}
	hierarchy := store.Hierarchy(target)
	if hierarchy.Root != "scratch" || len(hierarchy.Stages) != 2 || hierarchy.Stages[0].LayerCount != 1 || hierarchy.Stages[1].LayerCount != 2 {
		t.Fatalf("incomplete hierarchy: %+v", hierarchy)
	}
	if len(hierarchy.Stages[0].Candidates) != 1 || len(hierarchy.Stages[1].Candidates) != 2 {
		t.Fatalf("platform filtering or alternatives lost: %+v", hierarchy.Stages)
	}
	if hierarchy.Stages[0].Candidates[0].Evidence != "diffID-prefix" || hierarchy.Stages[0].Candidates[0].Tags[0] != "3.21.3" {
		t.Fatalf("lost version or evidence: %+v", hierarchy.Stages[0])
	}
	restored, err := OpenStore(store.Dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := restored.Hierarchy(target); len(got.Stages) != 2 {
		t.Fatalf("hierarchy did not survive restart: %+v", got)
	}
	page, ok := restored.Repository("docker.io/library/python", sha256Digest([]byte("python")))
	if !ok || len(page.Images) != 1 {
		t.Fatal("manifest lookup failed")
	}
}

func TestRegistryCrawlPaginationAuthenticationVariantsAndConfigPersistence(t *testing.T) {
	store := testStore(t)
	objects := map[string][]byte{}
	calls := map[string]int{}
	configs := map[string][]byte{}
	var leaves []descriptor
	for _, platform := range []Platform{{OS: "linux", Architecture: "amd64"}, {OS: "linux", Architecture: "amd64", Variant: "v3"}, {OS: "linux", Architecture: "arm64", Variant: "v8"}} {
		layer := testLayer(platform.Architecture + platform.Variant)
		config := []byte(fmt.Sprintf(`{ "os":"linux", "architecture":%q, "variant":%q, "created":"2026-11-01T12:00:00Z", "config":{"Labels":{"example":"label"},"Entrypoint":["/python"],"Cmd":["app.py"]},"rootfs":{"type":"layers","diff_ids":[%q]} }`, platform.Architecture, platform.Variant, layer.DiffID))
		configDigest := sha256Digest(config)
		configs[configDigest] = config
		objects["blobs/"+configDigest] = config
		body := jsonBytes(t, manifest{SchemaVersion: 2, Config: descriptor{Digest: configDigest}, Layers: []descriptor{{Digest: layer.Digest, Size: 123}}, Annotations: map[string]string{"org.opencontainers.image.base.name": "alpine:3.21"}})
		digest := sha256Digest(body)
		objects["manifests/"+digest] = body
		leaves = append(leaves, descriptor{Digest: digest, Platform: platform})
	}
	// An index nested inside an index carries the amd64/v3 subarchitecture.
	nested := jsonBytes(t, manifest{SchemaVersion: 2, Manifests: []descriptor{leaves[1]}})
	nestedDigest := sha256Digest(nested)
	objects["manifests/"+nestedDigest] = nested
	root := jsonBytes(t, manifest{SchemaVersion: 2, Manifests: []descriptor{leaves[0], {Digest: nestedDigest}, leaves[2], {Digest: sha256Digest([]byte("attestation")), Platform: Platform{OS: "unknown", Architecture: "unknown"}}}})
	objects["manifests/1.2.3-alpine"] = root
	objects["manifests/v1.2.3-alpine"] = root
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls[r.URL.Path]++
		if r.URL.Path == "/token" {
			if r.URL.Query().Get("scope") != "repository:library/python:pull" {
				t.Errorf("unexpected scope: %s", r.URL.RawQuery)
			}
			registryJSON(w, map[string]any{"token": "registry-only-token", "expires_in": 3600})
			return
		}
		if r.Header.Get("Authorization") != "Bearer registry-only-token" {
			w.Header().Set("WWW-Authenticate", fmt.Sprintf(`Bearer realm="%s/token",service="fixture"`, server.URL))
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/v2/library/python/tags/list" {
			if r.URL.Query().Get("last") == "" {
				w.Header().Set("Link", `</v2/library/python/tags/list?n=1000&last=1.2.3-alpine>; rel="next"`)
				registryJSON(w, map[string]any{"tags": []string{"1.2.3-alpine", "latest", "1.2.3-rc1"}})
			} else {
				registryJSON(w, map[string]any{"tags": []string{"v1.2.3-alpine", "1.2", "sha256-deadbeef.sig"}})
			}
			return
		}
		key := strings.TrimPrefix(r.URL.Path, "/v2/library/python/")
		if body, ok := objects[key]; ok {
			w.Header().Set("Docker-Content-Digest", sha256Digest(body))
			w.Write(body)
			return
		}
		t.Errorf("unexpected registry request (layers must never be fetched): %s", r.URL.Path)
		http.NotFound(w, r)
	}))
	defer server.Close()
	scraper := &Scraper{Store: store, Client: &Client{HTTP: server.Client(), Endpoint: func(string) string { return server.URL }}, Log: slog.New(slog.DiscardHandler)}
	repo := scraper.Crawl(context.Background(), RepositoryConfig{Repository: "docker.io/library/python", TagPattern: `^v?[0-9]+\.[0-9]+\.[0-9]+-alpine$`}, time.Hour)
	if len(repo.Errors) != 0 || repo.ListedTags != 6 || repo.MatchedTags != 2 || len(repo.Images) != 3 {
		t.Fatalf("unexpected crawl: %+v", repo)
	}
	for _, image := range repo.Images {
		if len(image.Tags) != 2 || image.Labels["example"] != "label" || image.Created != "2026-11-01T12:00:00Z" || len(image.Entrypoint) != 1 {
			t.Fatalf("metadata missing: %+v", image)
		}
		body, err := store.ReadObject("config", image.ConfigDigest)
		if err != nil || !bytes.Equal(body, configs[image.ConfigDigest]) {
			t.Fatalf("config changed: %v", err)
		}
		if calls["/v2/library/python/blobs/"+image.ConfigDigest] != 1 {
			t.Fatal("config fetched again for tag alias")
		}
	}
	if calls["/token"] != 1 {
		t.Fatal("anonymous registry token not reused")
	}
	if err := store.Put(repo); err != nil {
		t.Fatal(err)
	}
	before := calls["/v2/library/python/manifests/1.2.3-alpine"]
	second := scraper.Crawl(context.Background(), RepositoryConfig{Repository: repo.Repository, TagPattern: repo.TagPattern}, time.Hour)
	if calls["/v2/library/python/manifests/1.2.3-alpine"] != before || len(second.Images) != 3 {
		t.Fatal("recent tags were fetched again or metadata lost")
	}
}

func TestRateLimitedCrawlResumesUncheckedTags(t *testing.T) {
	store := testStore(t)
	var requested []string
	config := []byte(`{"os":"linux","architecture":"amd64","rootfs":{"diff_ids":[]}}`)
	configDigest := sha256Digest(config)
	body := jsonBytes(t, manifest{SchemaVersion: 2, Config: descriptor{Digest: configDigest}, Layers: []descriptor{}})
	limited := true
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "tags/list") {
			registryJSON(w, map[string]any{"tags": []string{"1.0.0", "2.0.0", "3.0.0"}})
			return
		}
		if strings.Contains(r.URL.Path, "/blobs/") {
			w.Write(config)
			return
		}
		tag := filepath.Base(r.URL.Path)
		requested = append(requested, tag)
		if limited && tag == "2.0.0" {
			w.Header().Set("Retry-After", "3600")
			w.WriteHeader(429)
			return
		}
		w.Write(body)
	}))
	defer server.Close()
	s := &Scraper{Store: store, Client: &Client{HTTP: server.Client(), Endpoint: func(string) string { return server.URL }}}
	cfg := RepositoryConfig{Repository: "example.org/base", TagPattern: `^[0-9]+\.[0-9]+\.[0-9]+$`}
	first := s.Crawl(context.Background(), cfg, 12*time.Hour)
	if !slices.Equal(requested, []string{"1.0.0", "2.0.0"}) || len(first.Errors) != 1 || time.Until(first.NextCrawl) < 59*time.Minute {
		t.Fatalf("quota not respected: %v %+v", requested, first)
	}
	if err := store.Put(first); err != nil {
		t.Fatal(err)
	}
	limited = false
	requested = nil
	second := s.Crawl(context.Background(), cfg, 12*time.Hour)
	if !slices.Equal(requested, []string{"2.0.0", "3.0.0"}) || len(second.Errors) != 0 || len(second.Images) != 1 || len(second.Images[0].Tags) != 3 {
		t.Fatalf("crawl did not advance: %v %+v", requested, second)
	}
}

func TestMovedTagRetainsHistoricalBase(t *testing.T) {
	store := testStore(t)
	objects := map[string][]byte{}
	var manifests [][]byte
	for _, name := range []string{"old", "rebuilt"} {
		layer := testLayer(name)
		cfg := jsonBytes(t, map[string]any{"os": "linux", "architecture": "amd64", "rootfs": map[string]any{"diff_ids": []string{layer.DiffID}}})
		digest := sha256Digest(cfg)
		objects[digest] = cfg
		manifests = append(manifests, jsonBytes(t, manifest{SchemaVersion: 2, Config: descriptor{Digest: digest}, Layers: []descriptor{{Digest: layer.Digest}}}))
	}
	current := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "tags/list") {
			registryJSON(w, map[string]any{"tags": []string{"1.2.3"}})
			return
		}
		if strings.Contains(r.URL.Path, "/blobs/") {
			w.Write(objects[filepath.Base(r.URL.Path)])
			return
		}
		w.Write(manifests[current])
	}))
	defer server.Close()
	s := &Scraper{Store: store, Client: &Client{HTTP: server.Client(), Endpoint: func(string) string { return server.URL }}}
	cfg := RepositoryConfig{Repository: "example.org/base", TagPattern: `^1\.2\.3$`}
	first := s.Crawl(context.Background(), cfg, time.Hour)
	if len(first.Images) != 1 || len(first.Errors) > 0 {
		t.Fatalf("first crawl failed: %+v", first)
	}
	first.TagCheckedAt["1.2.3"] = time.Now().Add(-2 * time.Hour)
	if err := store.Put(first); err != nil {
		t.Fatal(err)
	}
	current = 1
	second := s.Crawl(context.Background(), cfg, time.Hour)
	if len(second.Images) != 2 || len(second.Errors) > 0 {
		t.Fatalf("historical image lost: %+v", second)
	}
	if err := store.Put(second); err != nil {
		t.Fatal(err)
	}
	for _, image := range second.Images {
		if image.Digest == first.Images[0].Digest && len(image.CurrentTags) != 0 {
			t.Fatal("moved tag still marked current on old manifest")
		}
	}
	hierarchy := store.Hierarchy(Target{Digest: sha256Digest([]byte("derived")), Platform: first.Images[0].Platform, Layers: append(append([]Layer{}, first.Images[0].Layers...), testLayer("application"))})
	if len(hierarchy.Stages) != 1 || hierarchy.Stages[0].Candidates[0].Digest != first.Images[0].Digest {
		t.Fatalf("historical ancestry unavailable: %+v", hierarchy)
	}
}

func TestAPIAuthenticationConfigDownloadAndValidation(t *testing.T) {
	store := testStore(t)
	config := []byte(" {\n \"os\":\"linux\"\n} \n")
	digest := sha256Digest(config)
	if err := store.WriteObject("config", digest, config); err != nil {
		t.Fatal(err)
	}
	api := &API{Store: store, Allowed: []string{"mcp"}, Authenticate: func(_ context.Context, token string) (string, error) {
		if token == "mcp-token" {
			return "mcp", nil
		}
		return "", errors.New("denied")
	}}
	handler := api.Handler()
	for _, tc := range []struct {
		path, token string
		want        int
	}{{"/v1/repositories", "", 401}, {"/v1/repository?name=missing&digest=bad", "mcp-token", 400}, {"/v1/configs/invalid", "mcp-token", 400}, {"/v1/configs/" + digest + "?encoding=base64", "mcp-token", 200}} {
		r := httptest.NewRequest(http.MethodGet, tc.path, nil)
		if tc.token != "" {
			r.Header.Set("Authorization", "Bearer "+tc.token)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Fatalf("%s: HTTP %d: %s", tc.path, w.Code, w.Body)
		}
		if tc.want == 200 {
			var result struct {
				GzipBase64 string `json:"gzipBase64"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			encoded, err := base64.StdEncoding.DecodeString(result.GzipBase64)
			if err != nil {
				t.Fatal(err)
			}
			z, err := gzip.NewReader(bytes.NewReader(encoded))
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(z)
			z.Close()
			if err != nil || !bytes.Equal(body, config) {
				t.Fatal("download altered original OCI config bytes")
			}
		}
	}
	// Digest mismatches are rejected before data reaches persistent storage.
	if err := store.WriteObject("config", digest, []byte("tampered")); err == nil {
		t.Fatal("unverified config persisted")
	}
}

func TestDefaultRepositoryPatterns(t *testing.T) {
	cfg, err := LoadConfig("../../chart/files/base-images.json")
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Repositories) < 40 {
		t.Fatal("base image families missing")
	}
	patterns := map[string]*regexp.Regexp{}
	for _, repo := range cfg.Repositories {
		patterns[repo.Repository] = regexp.MustCompile(repo.TagPattern)
	}
	for _, tc := range []struct {
		repo, tag string
		want      bool
	}{
		{"python", "3.13.5-alpine3.21", true}, {"php", "8.4.7-fpm-alpine3.21", true}, {"nginx", "1.27.5-alpine", true},
		{"python", "3.13.5-rc1", false}, {"python", "latest", false}, {"nginx", "sha256-deadbeef.sig", false}, {"python", "3.13", false},
	} {
		if patterns["docker.io/library/"+tc.repo].MatchString(tc.tag) != tc.want {
			t.Errorf("%s tag filter: %s", tc.repo, tc.tag)
		}
	}
	for tag, want := range map[string]bool{"0.9.5": true, "0.9.5-python3.13-bookworm-slim": true, "0.9.5-alpine": true, "latest": false, "0.9.5-rc1": false} {
		if patterns["ghcr.io/astral-sh/uv"].MatchString(tag) != want {
			t.Errorf("uv tag %s matched incorrectly", tag)
		}
	}

	configFile := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(configFile, []byte(`{"interval":"12h","concurrency":2,"repositories":[{"repository":"docker.io/library/python","tagPattern":".*"}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadConfig(configFile); err == nil {
		t.Fatal("unanchored tag filter accepted")
	}
}

func registryJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}
