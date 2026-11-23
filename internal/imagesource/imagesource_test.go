package imagesource

import "testing"

// drone-auth as observed: an application appended onto Alpine, carrying
// Alpine's manifest annotations unchanged.
func droneAuth() map[string]any {
	return map[string]any{
		"annotations": map[string]any{
			officialKey:                          "amd64",
			sourceKey:                            "https://github.com/alpinelinux/docker-alpine.git#0db70ae:x86_64",
			versionKey:                           "3.20.10",
			revisionKey:                          "0db70ae",
			"org.opencontainers.image.base.name": "scratch",
		},
		"repoDigests": []any{"zot.example/asterate/drone-auth@sha256:36b9"},
		"manifests":   []any{map[string]any{"layers": []any{map[string]any{"diffID": "sha256:a"}, map[string]any{"diffID": "sha256:b"}}}},
		"status": map[string]any{
			"image": "zot.example/asterate/drone-auth@sha256:36b9", "source": "https://github.com/alpinelinux/docker-alpine", "version": "3.20.10",
		},
	}
}

func TestOfficialAnnotationsOutsideOfficialRepositoryAreInherited(t *testing.T) {
	claim := Of(droneAuth(), nil)
	if claim.Source != "" || claim.Version != "" || claim.Inherited != ReasonOfficialAnnotations {
		t.Fatalf("claim = %+v", claim)
	}
}

func TestOfficialRepositoriesKeepTheirClaim(t *testing.T) {
	for _, ref := range []string{"docker.io/library/alpine:3.23", "alpine:3.23", "mirror.example/docker.io/library/alpine:3.23"} {
		image := droneAuth()
		image["repoDigests"] = []any{ref}
		image["status"].(map[string]any)["image"] = ref
		if claim := Of(image, nil); claim.Source != "https://github.com/alpinelinux/docker-alpine" || claim.Inherited != "" {
			t.Fatalf("%s: claim = %+v", ref, claim)
		}
	}
}

func TestImageRepositoryOverrideIsKept(t *testing.T) {
	image := droneAuth()
	image["status"].(map[string]any)["source"] = "https://github.com/asterate/drone-auth"
	if claim := Of(image, nil); claim.Source != "https://github.com/asterate/drone-auth" {
		t.Fatalf("claim = %+v", claim)
	}
}

func TestClaimMatchingAnExtendedBaseIsInherited(t *testing.T) {
	base := map[string]any{
		"labels":    map[string]any{sourceKey: "https://github.com/example/base", revisionKey: "r1"},
		"manifests": []any{map[string]any{"layers": []any{map[string]any{"diffID": "sha256:a"}}}},
	}
	app := map[string]any{
		"labels":    map[string]any{sourceKey: "https://github.com/example/base", revisionKey: "r1", versionKey: "1.0"},
		"repoTags":  []any{"registry.example/app:2.4.1"},
		"manifests": []any{map[string]any{"layers": []any{map[string]any{"diffID": "sha256:a"}, map[string]any{"diffID": "sha256:c"}}}},
		"status":    map[string]any{"source": "https://github.com/example/base", "version": "2.4.1"},
	}
	index := NewIndex([]map[string]any{base, app})
	claim := Of(app, index)
	if claim.Source != "" || claim.Inherited != ReasonBaseImage || claim.Version != "2.4.1" {
		t.Fatalf("claim = %+v", claim)
	}
	if claim := Of(base, index); claim.Source != "" && claim.Inherited != "" {
		t.Fatalf("base claim = %+v", claim)
	}
	// A different source revision is the image's own build of the same repository.
	app["labels"].(map[string]any)[revisionKey] = "r2"
	if claim := Of(app, NewIndex([]map[string]any{base, app})); claim.Source != "https://github.com/example/base" {
		t.Fatalf("own build claim = %+v", claim)
	}
}

func TestNormalize(t *testing.T) {
	for raw, want := range map[string]string{
		"https://github.com/AlpineLinux/docker-alpine.git#abc:x86_64": "https://github.com/alpinelinux/docker-alpine",
		"git@github.com:org/repo.git":                                 "https://github.com/org/repo",
		"https://gitlab.com/group/sub/repo/-/tree/main":               "https://gitlab.com/group/sub/repo",
		"not a url": "",
	} {
		if got := Normalize(raw, false); got != want {
			t.Errorf("Normalize(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestReduceKeepsWhatOfNeeds(t *testing.T) {
	full := droneAuth()
	full["annotations"].(map[string]any)["unrelated"] = "x"
	reduced := Reduce(full)
	if _, ok := reduced["annotations"].(map[string]any)["unrelated"]; ok {
		t.Fatal("unrelated annotation kept")
	}
	if Of(reduced, nil) != Of(full, nil) {
		t.Fatalf("reduced claim %+v differs from %+v", Of(reduced, nil), Of(full, nil))
	}
	if len(chainsOf(reduced)) != 1 || len(chainsOf(reduced)[0]) != 2 {
		t.Fatalf("chains = %v", chainsOf(reduced))
	}
}
