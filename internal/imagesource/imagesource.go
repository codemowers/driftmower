// Package imagesource decides whether the source repository and version a
// ContainerImage claims belong to the image itself or were inherited from
// its base image.
//
// Image metadata is unreliable: config labels are inherited by every
// Dockerfile FROM, and builders that append layers to a base (ko, crane,
// apko-style tools, some kaniko setups) copy the base's manifest annotations
// as well. An application built on Alpine then claims to be
// github.com/alpinelinux/docker-alpine at Alpine's version. An inherited
// claim is unknown provenance, not a link to the base image's repository.
package imagesource

import (
	"net/url"
	"strings"
)

const (
	sourceKey   = "org.opencontainers.image.source"
	versionKey  = "org.opencontainers.image.version"
	revisionKey = "org.opencontainers.image.revision"
	// Docker Official Images builds (bashbrew) annotate every manifest; only
	// the official repositories themselves legitimately carry it.
	officialKey = "com.docker.official-images.bashbrew.arch"
)

// Reasons an image's own metadata claim is rejected.
const (
	ReasonOfficialAnnotations = "Docker Official Image annotations on a repository that is not an official image"
	ReasonBaseImage           = "same source metadata as a base image whose layers this image extends"
)

// Claim is an image's effective source repository and version. Inherited
// names why the metadata claim was discarded; Source and Version are then
// empty unless the version came from the image's own tags.
type Claim struct {
	Source    string
	Version   string
	Inherited string
}

type metadata struct {
	source, version, revision string
}

// sourceKeys mirrors the inventory's lookup order for an image's source.
var sourceKeys = []struct {
	field, key string
	forgeOnly  bool
}{
	{"annotations", sourceKey, false},
	{"labels", sourceKey, false},
	{"labels", "org.label-schema.vcs-url", false},
	{"labels", "source_repository", false},
	{"annotations", "org.opencontainers.image.url", true},
	{"labels", "org.opencontainers.image.url", true},
	{"labels", "org.label-schema.url", true},
}

func ownMetadata(obj map[string]any) metadata {
	var m metadata
	for _, k := range sourceKeys {
		if m.source != "" {
			break
		}
		values, _ := obj[k.field].(map[string]any)
		s, _ := values[k.key].(string)
		m.source = Normalize(s, k.forgeOnly)
	}
	for _, field := range []string{"annotations", "labels"} {
		values, _ := obj[field].(map[string]any)
		if m.version == "" {
			m.version, _ = values[versionKey].(string)
		}
		if m.revision == "" {
			m.revision, _ = values[revisionKey].(string)
		}
	}
	return m
}

func nestedString(obj map[string]any, path ...string) string {
	for i, key := range path {
		if i == len(path)-1 {
			s, _ := obj[key].(string)
			return s
		}
		next, ok := obj[key].(map[string]any)
		if !ok {
			return ""
		}
		obj = next
	}
	return ""
}

func stringSlice(v any) []string {
	items, _ := v.([]any)
	out := make([]string, 0, len(items))
	for _, item := range items {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// references returns the repositories (registry/path, without tag or digest)
// the image is known by.
func repositories(obj map[string]any) []string {
	var out []string
	refs := append(stringSlice(obj["repoTags"]), stringSlice(obj["repoDigests"])...)
	if image := nestedString(obj, "status", "image"); image != "" {
		refs = append(refs, image)
	}
	for _, ref := range refs {
		repo, _, _ := strings.Cut(ref, "@")
		if i := strings.LastIndex(repo, ":"); i > strings.LastIndex(repo, "/") {
			repo = repo[:i]
		}
		out = append(out, repo)
	}
	return out
}

// official reports whether a repository is a Docker Official Image, also
// through a pull-through mirror that keeps the library/ path.
func official(repo string) bool {
	parts := strings.Split(repo, "/")
	if len(parts) == 1 {
		return true
	}
	if len(parts) == 2 && (parts[0] == "docker.io" || parts[0] == "index.docker.io" || parts[0] == "registry-1.docker.io") {
		return true
	}
	return len(parts) >= 2 && parts[len(parts)-2] == "library"
}

func inheritedOfficial(obj map[string]any) bool {
	annotations, _ := obj["annotations"].(map[string]any)
	labels, _ := obj["labels"].(map[string]any)
	if annotations[officialKey] == nil && labels[officialKey] == nil {
		return false
	}
	repos := repositories(obj)
	if len(repos) == 0 {
		return false
	}
	for _, repo := range repos {
		if official(repo) {
			return false
		}
	}
	return true
}

// Of returns the image's effective claim. A status.source that differs from
// the image's own metadata came from an explicit ImageRepository override
// and is always kept. index may be nil when no other images are known.
func Of(obj map[string]any, index *Index) Claim {
	claim := Claim{Source: nestedString(obj, "status", "source"), Version: nestedString(obj, "status", "version")}
	own := ownMetadata(obj)
	if claim.Source == "" || own.source == "" || claim.Source != own.source {
		return claim
	}
	switch {
	case inheritedOfficial(obj):
		claim.Inherited = ReasonOfficialAnnotations
	case index.extendsBaseWithSameClaim(obj, own):
		claim.Inherited = ReasonBaseImage
	default:
		return claim
	}
	claim.Source = ""
	// A version taken from the inherited metadata is the base image's; a
	// version from the image's own tags stays.
	if claim.Version == own.version {
		claim.Version = ""
	}
	return claim
}

// Index holds the layer chains of known images and the metadata each one
// claims, to recognise an image that merely extends another.
type Index struct {
	chains map[string][]metadata
}

func chainsOf(obj map[string]any) [][]string {
	var out [][]string
	manifests, _ := obj["manifests"].([]any)
	for _, raw := range manifests {
		m, _ := raw.(map[string]any)
		layers, _ := m["layers"].([]any)
		var chain []string
		for _, raw := range layers {
			layer, _ := raw.(map[string]any)
			id, _ := layer["diffID"].(string)
			if id == "" {
				id, _ = layer["digest"].(string)
			}
			if id == "" {
				chain = nil
				break
			}
			chain = append(chain, id)
		}
		if len(chain) > 0 {
			out = append(out, chain)
		}
	}
	return out
}

// NewIndex indexes images by their exact layer chains.
func NewIndex(images []map[string]any) *Index {
	index := &Index{chains: map[string][]metadata{}}
	for _, obj := range images {
		own := ownMetadata(obj)
		if own.source == "" {
			continue
		}
		for _, chain := range chainsOf(obj) {
			key := strings.Join(chain, ",")
			index.chains[key] = append(index.chains[key], own)
		}
	}
	return index
}

func (index *Index) extendsBaseWithSameClaim(obj map[string]any, own metadata) bool {
	if index == nil {
		return false
	}
	for _, chain := range chainsOf(obj) {
		for n := len(chain) - 1; n > 0; n-- {
			for _, base := range index.chains[strings.Join(chain[:n], ",")] {
				if base.source == own.source && (base.revision == "" || own.revision == "" || base.revision == own.revision) {
					return true
				}
			}
		}
	}
	return false
}

// forges maps code hosting sites to the path segments naming a repository;
// zero keeps the path up to GitLab's /-/ separator.
var forges = map[string]int{"github.com": 2, "codeberg.org": 2, "bitbucket.org": 2, "gitlab.com": 0}

// Normalize turns a source reference into the lowercase repository URL that
// the image inventory (nodestatd) records: without revision (#rev:dir), .git
// suffix, trailing slash or forge subpaths. It returns "" for values that are
// not HTTP URLs, or not forge URLs when forgeOnly is set.
func Normalize(raw string, forgeOnly bool) string {
	raw, _, _ = strings.Cut(strings.TrimSpace(raw), "#")
	if rest, ok := strings.CutPrefix(raw, "git@"); ok {
		host, path, _ := strings.Cut(rest, ":")
		raw = "https://" + host + "/" + path
	}
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" {
		return ""
	}
	host := strings.ToLower(parsed.Host)
	path := strings.ToLower(strings.Trim(strings.TrimSuffix(strings.Trim(parsed.Path, "/"), ".git"), "/"))
	segments, forge := forges[host]
	switch {
	case forge && segments > 0:
		parts := strings.Split(path, "/")
		if len(parts) < segments {
			return ""
		}
		path = strings.Join(parts[:segments], "/")
	case forge:
		path, _, _ = strings.Cut(path, "/-/")
		if path == "" {
			return ""
		}
	case forgeOnly:
		return ""
	}
	if path == "" {
		return parsed.Scheme + "://" + host
	}
	return parsed.Scheme + "://" + host + "/" + strings.TrimSuffix(path, ".git")
}

// Reduce keeps only what Of and NewIndex read: status, references, the
// provenance annotations and labels, and each manifest's layer chain. Image
// informers use it as a transform so they need not hold full documents.
func Reduce(obj map[string]any) map[string]any {
	out := map[string]any{}
	for _, field := range []string{"apiVersion", "kind", "metadata", "status", "repoTags", "repoDigests"} {
		if v, ok := obj[field]; ok {
			out[field] = v
		}
	}
	keys := []string{versionKey, revisionKey, officialKey}
	for _, k := range sourceKeys {
		keys = append(keys, k.key)
	}
	for _, field := range []string{"annotations", "labels"} {
		values, _ := obj[field].(map[string]any)
		kept := map[string]any{}
		for _, key := range keys {
			if v, ok := values[key]; ok {
				kept[key] = v
			}
		}
		if len(kept) > 0 {
			out[field] = kept
		}
	}
	var manifests []any
	for _, chain := range chainsOf(obj) {
		layers := make([]any, len(chain))
		for i, id := range chain {
			layers[i] = map[string]any{"diffID": id}
		}
		manifests = append(manifests, map[string]any{"layers": layers})
	}
	if manifests != nil {
		out["manifests"] = manifests
	}
	return out
}
