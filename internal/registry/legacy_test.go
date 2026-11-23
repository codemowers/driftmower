package registry

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSchemaOneTagsAreTrackedAsUnsupportedAndDoNotTriggerErrorRetries(t *testing.T) {
	manifests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/tags/list") {
			registryJSON(w, map[string]any{"tags": []string{"2.7.10"}})
			return
		}
		manifests++
		w.Header().Set("Docker-Content-Digest", "sha256:"+strings.Repeat("a", 64))
		_, _ = w.Write([]byte(`{"schemaVersion":1,"signatures":[]}`))
	}))
	defer server.Close()
	store := testStore(t)
	scraper := &Scraper{Store: store, Client: &Client{HTTP: server.Client(), Endpoint: func(string) string { return server.URL }}}
	cfg := RepositoryConfig{Repository: "docker.io/library/python", TagPattern: ".*"}
	repo := scraper.Crawl(context.Background(), cfg, 12*time.Hour)
	if len(repo.Errors) != 0 || len(repo.UnsupportedTags) != 1 || repo.TagCheckedAt["2.7.10"].IsZero() {
		t.Fatalf("unsupported tag treated as error: %+v", repo)
	}
	if summary(repo).SkippedTags != 1 {
		t.Fatal("skip count missing from status")
	}
	if err := store.Put(repo); err != nil {
		t.Fatal(err)
	}
	next := scraper.Crawl(context.Background(), cfg, 12*time.Hour)
	if manifests != 1 || len(next.UnsupportedTags) != 1 || len(next.Errors) != 0 {
		t.Fatal("legacy tag retried before its crawl interval")
	}
}
func TestModernManifestDigestMismatchRemainsAnError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Docker-Content-Digest", "sha256:"+strings.Repeat("a", 64))
		_, _ = w.Write([]byte(`{"schemaVersion":2}`))
	}))
	defer server.Close()
	client := &Client{HTTP: server.Client(), Endpoint: func(string) string { return server.URL }}
	_, _, err := client.Fetch(context.Background(), "docker.io/library/python", "manifests", "3.14.0")
	var legacy *UnsupportedManifestError
	if err == nil || errors.As(err, &legacy) || !strings.Contains(err.Error(), "digest mismatch") {
		t.Fatalf("modern integrity check weakened: %v", err)
	}
}

func TestEmptyIndexesHaveNoImagesAndKeepTheirNormalCrawlInterval(t *testing.T) {
	for _, mediaType := range []string{"application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"} {
		t.Run(mediaType, func(t *testing.T) {
			manifests := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/tags/list") {
					registryJSON(w, map[string]any{"tags": []string{"2023.6.20250114.0"}})
					return
				}
				manifests++
				registryJSON(w, map[string]any{"schemaVersion": 2, "mediaType": mediaType, "manifests": []any{}})
			}))
			defer server.Close()
			store := testStore(t)
			scraper := &Scraper{Store: store, Client: &Client{HTTP: server.Client(), Endpoint: func(string) string { return server.URL }}}
			cfg := RepositoryConfig{Repository: "docker.io/library/amazonlinux", TagPattern: ".*"}
			repo := scraper.Crawl(context.Background(), cfg, 12*time.Hour)
			if len(repo.Errors) != 0 || len(repo.Images) != 0 || repo.MatchedTags != 1 || repo.NextCrawl.Sub(repo.CheckedAt) != 12*time.Hour {
				t.Fatalf("empty index treated as a broken image: %+v", repo)
			}
			if err := store.Put(repo); err != nil {
				t.Fatal(err)
			}
			next := scraper.Crawl(context.Background(), cfg, 12*time.Hour)
			if manifests != 1 || len(next.Errors) != 0 {
				t.Fatalf("empty index retried early: requests=%d errors=%v", manifests, next.Errors)
			}
		})
	}
}

func TestImageManifestWithoutConfigRemainsAnError(t *testing.T) {
	scraper := &Scraper{Store: testStore(t)}
	_, err := scraper.resolve(context.Background(), "docker.io/library/amazonlinux", sha256Digest([]byte("bad")), []byte(`{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json"}`), Platform{}, 0, map[string]bool{})
	if err == nil || !strings.Contains(err.Error(), "no config digest") {
		t.Fatalf("malformed image accepted: %v", err)
	}
}
