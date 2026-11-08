package findings

import (
	"reflect"
	"testing"

	"github.com/codemowers/driftmower/internal/crawler"
)

func TestKeys(t *testing.T) {
	for ref, want := range map[string][]string{
		"nginx:1.25": {"docker.io/library/nginx:1.25"},
		"nginx":      {"docker.io/library/nginx:latest"},
		"quay.io/jetstack/cert-manager-controller:v1.20.0": {"quay.io/jetstack/cert-manager-controller:v1.20.0"},
		"ghcr.io/org/app:v1@sha256:abc":                    {"ghcr.io/org/app@sha256:abc", "ghcr.io/org/app:v1"},
		"registry.local:5000/team/app":                     {"registry.local:5000/team/app:latest"},
		"index.docker.io/traefik/whoami:v1.10":             {"docker.io/traefik/whoami:v1.10"},
	} {
		if got := Keys(ref); !reflect.DeepEqual(got, want) {
			t.Errorf("Keys(%q) = %v, want %v", ref, got, want)
		}
	}
}

func TestIndexMatchesPodReferences(t *testing.T) {
	reports := []crawler.SourceReport{{URL: "https://github.com/nginx/nginx", Deployed: []crawler.DeployedVersion{{
		Version:    "1.25.5",
		Images:     []string{"docker.io/library/nginx:1.25"},
		References: []string{"docker.io/library/nginx:1.25", "docker.io/library/nginx@sha256:abc"},
	}}}}
	index := NewIndex(reports)
	for _, ref := range []string{"nginx:1.25", "docker.io/library/nginx:1.25", "nginx:1.25@sha256:abc", "nginx@sha256:abc"} {
		match, ok := index.Lookup(ref)
		if !ok || match.Version.Version != "1.25.5" {
			t.Errorf("Lookup(%q) = %v, %v", ref, match, ok)
		}
	}
	if _, ok := index.Lookup("nginx:1.27"); ok {
		t.Error("unrelated tag matched")
	}
}

func TestUnknownDigestCannotBorrowTagFindings(t *testing.T) {
	index := NewIndex([]crawler.SourceReport{{Deployed: []crawler.DeployedVersion{{Version: "1", References: []string{"nginx:latest", "nginx:v1@sha256:known"}}}}})
	for _, ref := range []string{"nginx@sha256:unknown", "nginx:v1@sha256:unknown"} {
		if _, ok := index.Lookup(ref); ok {
			t.Fatalf("unknown digest borrowed a moving tag: %s", ref)
		}
	}
	index = NewIndex([]crawler.SourceReport{{Deployed: []crawler.DeployedVersion{{References: []string{"nginx@sha256:known"}}}}})
	if _, ok := index.Lookup("nginx:latest"); ok {
		t.Fatal("digest-only reference invented a latest-tag association")
	}
}
