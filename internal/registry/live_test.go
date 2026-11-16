package registry_test

import (
	"context"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/codemowers/driftmower/internal/crawler"
	"github.com/codemowers/driftmower/internal/registry"
)

// Explicit opt-in: ordinary test runs never depend on public registry access
// or consume anonymous registry quotas.
func TestPublicRegistries(t *testing.T) {
	if os.Getenv("DRIFTMOWER_REGISTRY_LIVE_TEST") != "1" {
		t.Skip("set DRIFTMOWER_REGISTRY_LIVE_TEST=1 to check public registries")
	}
	store, err := registry.OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	scraper := &registry.Scraper{Store: store, Client: &registry.Client{HTTP: crawler.PublicHTTPClient()}, Log: slog.Default()}
	for _, cfg := range []registry.RepositoryConfig{
		{Repository: "docker.io/library/alpine", TagPattern: `^3\.21\.[0-9]+$`},
		{Repository: "docker.io/library/python", TagPattern: `^3\.13\.5-alpine3\.21$`},
		{Repository: "docker.io/library/nginx", TagPattern: `^1\.27\.5-alpine$`},
		{Repository: "docker.dragonflydb.io/dragonflydb/dragonfly", TagPattern: `^v1\.37\.0$`},
	} {
		t.Run(cfg.Repository, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			repo := scraper.Crawl(ctx, cfg, time.Hour)
			if len(repo.Errors) > 0 || repo.MatchedTags < 1 || len(repo.Images) == 0 {
				t.Fatalf("public registry crawl: matched=%d images=%d errors=%v", repo.MatchedTags, len(repo.Images), repo.Errors)
			}
			if err := store.Put(repo); err != nil {
				t.Fatal(err)
			}
			for _, image := range repo.Images {
				t.Logf("%s:%s %s/%s/%s: %d layers, created %s", image.Repository, image.Tags[0], image.Platform.OS, image.Platform.Architecture, image.Platform.Variant, len(image.Layers), image.Created)
			}
		})
	}
	if repo := store.Get("docker.io/library/python"); repo != nil {
		for _, image := range repo.Images {
			h := store.Hierarchy(registry.Target{Digest: image.Digest, Platform: image.Platform, Layers: image.Layers})
			t.Logf("Python %s: %d indexed hierarchy boundaries", image.Platform.Architecture, len(h.Stages))
		}
	}
}

// Opt-in single-manifest check with an existing mounted token. Never prints it.
func TestAuthenticatedGHCR(t *testing.T) {
	file := os.Getenv("DRIFTMOWER_GHCR_TOKEN_FILE")
	if file == "" {
		t.Skip("set DRIFTMOWER_GHCR_TOKEN_FILE to verify existing GHCR credentials")
	}
	client := &registry.Client{HTTP: crawler.PublicHTTPClient(), GitHubTokenFile: file, Status: &registry.RegistryStatusTracker{}}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	body, _, err := client.Fetch(ctx, "ghcr.io/astral-sh/uv", "manifests", "0.9.5")
	if err != nil {
		t.Fatal(err)
	}
	if len(body) == 0 || client.Status.Snapshot(time.Now())[0].Authentication != "authenticated" {
		t.Fatal("GHCR metadata was not fetched with authentication")
	}
	t.Log("GHCR authenticated metadata fetch succeeded")
}
