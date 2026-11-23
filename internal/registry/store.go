package registry

import (
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

type layerNode struct {
	children map[string]*layerNode
	images   []*Image
}

type Store struct {
	Dir                      string
	updatedAt                time.Time
	mu                       sync.RWMutex
	repositories             map[string]*Repository
	compressed, uncompressed *layerNode
}

func OpenStore(dir string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dir, "repositories"), 0700); err != nil {
		return nil, err
	}
	s := &Store{Dir: dir, updatedAt: time.Now().UTC(), repositories: map[string]*Repository{}}
	entries, err := os.ReadDir(filepath.Join(dir, "repositories"))
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json.gz") {
			continue
		}
		body, err := readGzip(filepath.Join(dir, "repositories", entry.Name()), 256<<20)
		if err != nil {
			return nil, err
		}
		var repo Repository
		if err := json.Unmarshal(body, &repo); err != nil {
			return nil, fmt.Errorf("read registry snapshot %s: %w", entry.Name(), err)
		}
		if !repositoryPattern.MatchString(repo.Repository) {
			return nil, errors.New("invalid repository in snapshot")
		}
		s.repositories[repo.Repository] = &repo
	}
	s.reindex()
	return s, nil
}

func readGzip(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	z, err := gzip.NewReader(f)
	if err != nil {
		return nil, err
	}
	defer z.Close()
	body, err := io.ReadAll(io.LimitReader(z, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, errors.New("stored registry metadata exceeds size limit")
	}
	return body, nil
}

func writeGzip(path string, body []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".registry-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	z := gzip.NewWriter(f)
	if _, err := z.Write(body); err != nil {
		z.Close()
		f.Close()
		return err
	}
	if err := z.Close(); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

func (s *Store) objectPath(kind, digest string) (string, error) {
	if !digestPattern.MatchString(digest) || (kind != "config" && kind != "manifest") {
		return "", errors.New("invalid registry object")
	}
	return filepath.Join(s.Dir, "objects", strings.ReplaceAll(digest, ":", "-"), kind+".json.gz"), nil
}

func (s *Store) ReadObject(kind, digest string) ([]byte, error) {
	path, err := s.objectPath(kind, digest)
	if err != nil {
		return nil, err
	}
	body, err := readGzip(path, maxMetadataBytes)
	if err != nil {
		return nil, err
	}
	if err := VerifyDigest(digest, body); err != nil {
		return nil, err
	}
	return body, nil
}

func (s *Store) WriteObject(kind, digest string, body []byte) error {
	if err := VerifyDigest(digest, body); err != nil {
		return err
	}
	path, err := s.objectPath(kind, digest)
	if err != nil {
		return err
	}
	return writeGzip(path, body)
}

func (s *Store) Put(repo *Repository) error {
	body, err := json.Marshal(repo)
	if err != nil {
		return err
	}
	path := filepath.Join(s.Dir, "repositories", strings.TrimPrefix(sha256Digest([]byte(repo.Repository)), "sha256:")+".json.gz")
	if err := writeGzip(path, body); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.repositories[repo.Repository] = repo
	s.updatedAt = time.Now().UTC()
	s.reindex()
	return nil
}

func (s *Store) Configure(repositories []RepositoryConfig) {
	s.mu.Lock()
	defer s.mu.Unlock()
	keep := map[string]bool{}
	changed := false
	for _, cfg := range repositories {
		keep[cfg.Repository] = true
		if s.repositories[cfg.Repository] == nil {
			changed = true
			s.repositories[cfg.Repository] = &Repository{Repository: cfg.Repository, TagPattern: cfg.TagPattern, Images: []Image{}}
		}
	}
	for key := range s.repositories {
		if !keep[key] {
			changed = true
			delete(s.repositories, key)
		}
	}
	if changed {
		s.updatedAt = time.Now().UTC()
		s.reindex()
	}
}

func (s *Store) Get(name string) *Repository {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.repositories[name]
}

func summary(repo *Repository) RepositorySummary {
	return RepositorySummary{SkippedTags: len(repo.UnsupportedTags), Repository: repo.Repository, TagPattern: repo.TagPattern, CheckedAt: repo.CheckedAt, NextCrawl: repo.NextCrawl, ListedTags: repo.ListedTags, MatchedTags: repo.MatchedTags, ImageCount: len(repo.Images), Errors: repo.Errors}
}

func (s *Store) Summaries() []RepositorySummary {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]RepositorySummary, 0, len(s.repositories))
	for _, repo := range s.repositories {
		out = append(out, summary(repo))
	}
	slices.SortFunc(out, func(a, b RepositorySummary) int { return strings.Compare(a.Repository, b.Repository) })
	return out
}

func (s *Store) Repository(name, digest string) (*RepositoryDetail, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	repo := s.repositories[name]
	if repo == nil {
		return nil, false
	}
	filtered := repo.Images
	if digest != "" {
		filtered = []Image{}
		for _, image := range repo.Images {
			if image.Digest == digest {
				filtered = append(filtered, image)
			}
		}
	}
	images := append([]Image{}, filtered...)
	if digest == "" {
		// The listing omits per-image detail; select a digest for layers and labels.
		for i := range images {
			images[i].LayerCount = len(images[i].Layers)
			images[i].Layers, images[i].Labels, images[i].Annotations = nil, nil, nil
			images[i].Entrypoint, images[i].Cmd, images[i].WorkingDir, images[i].User = nil, nil, "", ""
		}
	}
	return &RepositoryDetail{RepositorySummary: summary(repo), Images: images}, true
}

// The trie indexes full image chains at their terminal node, allowing a
// derived image's ordered layers to discover every known ancestor boundary.
func (s *Store) reindex() {
	s.compressed = &layerNode{}
	s.uncompressed = &layerNode{}
	for _, repo := range s.repositories {
		for i := range repo.Images {
			image := &repo.Images[i]
			if len(image.Layers) == 0 {
				continue
			}
			for _, uncompressed := range []bool{false, true} {
				node := s.compressed
				if uncompressed {
					node = s.uncompressed
				}
				valid := true
				for _, layer := range image.Layers {
					digest := layer.Digest
					if uncompressed {
						digest = layer.DiffID
					}
					if !digestPattern.MatchString(digest) {
						valid = false
						break
					}
					if node.children == nil {
						node.children = map[string]*layerNode{}
					}
					if node.children[digest] == nil {
						node.children[digest] = &layerNode{}
					}
					node = node.children[digest]
				}
				if valid {
					node.images = append(node.images, image)
				}
			}
		}
	}
}

func (s *Store) Hierarchy(target Target) Hierarchy {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := Hierarchy{Digest: target.Digest, Platform: target.Platform, LayerCount: len(target.Layers), Root: "scratch", Stages: []Stage{}}
	compressed, uncompressed := s.compressed, s.uncompressed
	for i, layer := range target.Layers {
		if compressed != nil {
			compressed = compressed.children[layer.Digest]
		}
		if uncompressed != nil {
			uncompressed = uncompressed.children[layer.DiffID]
		}
		if compressed == nil && uncompressed == nil {
			break
		}
		candidates := map[string]Candidate{}
		for _, entry := range []struct {
			node     *layerNode
			evidence string
		}{{compressed, "compressed-layer-prefix"}, {uncompressed, "diffID-prefix"}} {
			if entry.node == nil {
				continue
			}
			for _, image := range entry.node.images {
				if image.Platform.OS != target.Platform.OS || image.Platform.Architecture != target.Platform.Architecture {
					continue
				}
				if target.Platform.Variant != "" && image.Platform.Variant != "" && image.Platform.Variant != target.Platform.Variant {
					continue
				}
				key := image.Repository + "@" + image.Digest
				candidates[key] = Candidate{Repository: image.Repository, Digest: image.Digest, Tags: image.Tags, Platform: image.Platform, Created: image.Created, Evidence: entry.evidence}
			}
		}
		if len(candidates) == 0 {
			continue
		}
		stage := Stage{LayerCount: i + 1, Candidates: []Candidate{}, Truncated: len(candidates) > 50}
		for _, candidate := range candidates {
			stage.Candidates = append(stage.Candidates, candidate)
		}
		slices.SortFunc(stage.Candidates, func(a, b Candidate) int { return strings.Compare(a.Repository+"@"+a.Digest, b.Repository+"@"+b.Digest) })
		stage.Candidates = stage.Candidates[:min(len(stage.Candidates), 50)]
		out.Stages = append(out.Stages, stage)
	}
	return out
}

func (s *Store) UpdatedAt() time.Time { s.mu.RLock(); defer s.mu.RUnlock(); return s.updatedAt }
