package mcpserver

import (
	"testing"

	"github.com/codemowers/driftmower/internal/crawler"
)

func TestResolveImageByDigestOrReference(t *testing.T) {
	reports := []crawler.SourceReport{{URL: "https://github.com/a/b", Deployed: []crawler.DeployedVersion{
		{Version: "v1.2.0", References: []string{"ghcr.io/a/b:v1.2.0", "ghcr.io/a/b@sha256:abc"}},
	}}}
	if m, ok := resolveImage(reports, "sha256:abc"); !ok || m.Version.Version != "v1.2.0" {
		t.Fatalf("by digest: %v %v", m, ok)
	}
	if m, ok := resolveImage(reports, "ghcr.io/a/b@sha256:abc"); !ok || m.Source.URL != "https://github.com/a/b" {
		t.Fatalf("by reference: %v %v", m, ok)
	}
	if _, ok := resolveImage(reports, "sha256:other"); ok {
		t.Fatal("unknown digest resolved")
	}
}
