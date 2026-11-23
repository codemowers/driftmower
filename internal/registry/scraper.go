package registry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
)

type RepositoryConfig struct {
	Repository string `json:"repository"`
	TagPattern string `json:"tagPattern"`
}

type Config struct {
	Interval     string             `json:"interval"`
	Concurrency  int                `json:"concurrency"`
	Repositories []RepositoryConfig `json:"repositories"`
}

func LoadConfig(path string) (Config, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	if err := json.Unmarshal(body, &cfg); err != nil {
		return cfg, err
	}
	interval, err := time.ParseDuration(cfg.Interval)
	if err != nil || interval < time.Minute {
		return cfg, errors.New("registry interval must be at least one minute")
	}
	if cfg.Concurrency < 1 || cfg.Concurrency > 8 {
		return cfg, errors.New("registry concurrency must be between 1 and 8")
	}
	seen := map[string]bool{}
	for _, r := range cfg.Repositories {
		if !repositoryPattern.MatchString(r.Repository) || seen[r.Repository] {
			return cfg, fmt.Errorf("invalid or duplicate repository %q", r.Repository)
		}
		seen[r.Repository] = true
		if !strings.HasPrefix(r.TagPattern, "^") || !strings.HasSuffix(r.TagPattern, "$") {
			return cfg, fmt.Errorf("tag pattern for %s must be anchored", r.Repository)
		}
		if _, err := regexp.Compile(r.TagPattern); err != nil {
			return cfg, err
		}
	}
	return cfg, nil
}

type Scraper struct {
	Client     *Client
	Store      *Store
	ConfigFile string
	Log        *slog.Logger
}

// Run rereads the mounted ConfigMap on each scheduling round. A bad update
// retains the last validated configuration and is reported explicitly.
func (s *Scraper) Run(ctx context.Context) error {
	cfg, err := LoadConfig(s.ConfigFile)
	if err != nil {
		return err
	}
	s.Store.Configure(cfg.Repositories)
	active := map[string]bool{}
	wakeup := make(chan struct{}, 1)
	var mu sync.Mutex
	var workers sync.WaitGroup
	defer workers.Wait()
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		if next, err := LoadConfig(s.ConfigFile); err != nil {
			s.Log.Error("registry configuration reload failed", "error", err)
		} else {
			cfg = next
			s.Store.Configure(cfg.Repositories)
		}
		interval, _ := time.ParseDuration(cfg.Interval)
		if s.Client.Status != nil {
			s.Client.Status.Configure(cfg.Repositories)
		}
		for _, r := range cfg.Repositories {
			if s.Client.Status != nil && s.Client.Status.Blocked(registryHost(r.Repository), time.Now()) != nil {
				continue
			}
			current := s.Store.Get(r.Repository)
			if current != nil && current.TagPattern == r.TagPattern && current.NextCrawl.After(time.Now()) {
				continue
			}
			mu.Lock()
			if active[r.Repository] || len(active) >= cfg.Concurrency {
				mu.Unlock()
				continue
			}
			active[r.Repository] = true
			if s.Client.Status != nil {
				s.Client.Status.Start(r.Repository)
			}
			mu.Unlock()
			workers.Add(1)
			go func(r RepositoryConfig) {
				defer workers.Done()
				defer func() {
					mu.Lock()
					delete(active, r.Repository)
					mu.Unlock()
					select {
					case wakeup <- struct{}{}:
					default:
					}
				}()
				crawlCtx, cancel := context.WithTimeout(ctx, 2*time.Hour)
				defer cancel()
				repo := s.Crawl(crawlCtx, r, interval)
				if s.Client.Status != nil {
					s.Client.Status.Finish(r.Repository, repo.Errors, time.Now())
				}
				if ctx.Err() != nil {
					return
				}
				if err := s.Store.Put(repo); err != nil {
					s.Log.Error("registry snapshot not saved", "repository", r.Repository, "error", err)
					return
				}
				if len(repo.Errors) > 0 {
					s.Log.Warn("registry scraped with errors", "repository", r.Repository, "images", len(repo.Images), "tags", repo.MatchedTags, "errors", len(repo.Errors), "errorDetails", repo.Errors)
				} else {
					s.Log.Info("registry scraped", "repository", r.Repository, "images", len(repo.Images), "tags", repo.MatchedTags)
				}
			}(r)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		case <-wakeup:
		}
	}
}

type descriptor struct {
	MediaType string   `json:"mediaType"`
	Digest    string   `json:"digest"`
	Size      int64    `json:"size"`
	Platform  Platform `json:"platform"`
}
type manifest struct {
	SchemaVersion int               `json:"schemaVersion"`
	MediaType     string            `json:"mediaType"`
	Manifests     []descriptor      `json:"manifests"`
	Config        descriptor        `json:"config"`
	Layers        []descriptor      `json:"layers"`
	Annotations   map[string]string `json:"annotations"`
}
type imageConfig struct {
	Platform
	Created string `json:"created"`
	Config  struct {
		Labels     map[string]string `json:"Labels"`
		Entrypoint []string          `json:"Entrypoint"`
		Cmd        []string          `json:"Cmd"`
		WorkingDir string            `json:"WorkingDir"`
		User       string            `json:"User"`
	} `json:"config"`
	RootFS struct {
		DiffIDs []string `json:"diff_ids"`
	} `json:"rootfs"`
}

func (s *Scraper) Crawl(ctx context.Context, cfg RepositoryConfig, interval time.Duration) *Repository {
	old := s.Store.Get(cfg.Repository)
	now := time.Now()
	repo := &Repository{Repository: cfg.Repository, TagPattern: cfg.TagPattern, CheckedAt: now, NextCrawl: now.Add(interval), Images: []Image{}, TagCheckedAt: map[string]time.Time{}, UnsupportedTags: map[string]string{}}
	fail := func(err error) {
		if len(repo.Errors) < 100 {
			repo.Errors = append(repo.Errors, err.Error())
		}
		repo.NextCrawl = time.Now().Add(min(interval, 15*time.Minute))
		var upstream *HTTPError
		if errors.As(err, &upstream) && upstream.RetryAfter > 0 {
			repo.NextCrawl = time.Now().Add(upstream.RetryAfter)
		}
	}
	tags, err := s.Client.Tags(ctx, cfg.Repository)
	if err != nil {
		fail(err)
		if old != nil {
			repo.Images = old.Images
			repo.TagCheckedAt = old.TagCheckedAt
			repo.UnsupportedTags = old.UnsupportedTags
		}
		return repo
	}
	repo.ListedTags = len(tags)
	pattern := regexp.MustCompile(cfg.TagPattern)
	tags = slices.DeleteFunc(tags, func(tag string) bool { return !pattern.MatchString(tag) })
	repo.MatchedTags = len(tags)
	// Oldest checks first. After a registry quota is hit, the next round advances
	// to unchecked tags instead of spending its quota on the same first page.
	checked := map[string]time.Time{}
	previous := map[string][]Image{}
	images := map[string]*Image{}
	if old != nil {
		checked = old.TagCheckedAt
		for _, image := range old.Images {
			currentTags := image.CurrentTags
			if currentTags == nil {
				currentTags = image.Tags
			}
			for _, tag := range currentTags {
				previous[tag] = append(previous[tag], image)
			}
			// Tags can move after rebuilds. Preserve the observed immutable
			// image so older derived images can still find their ancestry.
			clone := image
			clone.Tags = append([]string{}, image.Tags...)
			clone.CurrentTags = []string{}
			images[image.Digest+"/"+image.Platform.Architecture+"/"+image.Platform.Variant] = &clone
		}
	}
	slices.SortStableFunc(tags, func(a, b string) int { return checked[a].Compare(checked[b]) })
	resolved := map[string][]Image{}
	paused := false
	for _, tag := range tags {
		if old != nil && old.UnsupportedTags[tag] != "" {
			repo.UnsupportedTags[tag] = old.UnsupportedTags[tag]
		}
		if last, ok := checked[tag]; ok {
			repo.TagCheckedAt[tag] = last
		}
		found := previous[tag]
		due := checked[tag].IsZero() || now.Sub(checked[tag]) >= interval || old == nil || old.TagPattern != cfg.TagPattern
		if due && !paused {
			if err := ctx.Err(); err != nil {
				fail(err)
				paused = true
			} else {
				body, digest, err := s.Client.Fetch(ctx, cfg.Repository, "manifests", tag)
				var fetched []Image
				if err == nil {
					var ok bool
					fetched, ok = resolved[digest]
					if !ok {
						fetched, err = s.resolve(ctx, cfg.Repository, digest, body, Platform{}, 0, map[string]bool{})
						if err == nil {
							resolved[digest] = fetched
						}
					}
				}
				var unsupported *UnsupportedManifestError
				if errors.As(err, &unsupported) {
					repo.UnsupportedTags[tag] = unsupported.Error()
					repo.TagCheckedAt[tag] = time.Now()
					found = nil
				} else if err != nil {
					fail(fmt.Errorf("tag %s: %w", tag, err))
					var upstream *HTTPError
					if errors.As(err, &upstream) && (upstream.Status == 429 || upstream.Status == 401 || upstream.Status == 403 || upstream.Status >= 500) {
						paused = true
					}
				} else {
					delete(repo.UnsupportedTags, tag)
					found = fetched
					repo.TagCheckedAt[tag] = time.Now()
				}
			}
		}
		for _, image := range found {
			key := image.Digest + "/" + image.Platform.Architecture + "/" + image.Platform.Variant
			current := images[key]
			if current == nil {
				clone := image
				clone.Tags = []string{}
				clone.CurrentTags = []string{}
				current = &clone
				images[key] = current
			}
			current.Tags = append(current.Tags, tag)
			current.CurrentTags = append(current.CurrentTags, tag)
		}
	}
	for _, image := range images {
		slices.Sort(image.Tags)
		image.Tags = slices.Compact(image.Tags)
		slices.Sort(image.CurrentTags)
		image.CurrentTags = slices.Compact(image.CurrentTags)
		repo.Images = append(repo.Images, *image)
	}
	slices.SortFunc(repo.Images, func(a, b Image) int {
		if order := strings.Compare(b.Created, a.Created); order != 0 {
			return order
		}
		return strings.Compare(a.Platform.Architecture+"/"+a.Platform.Variant+"/"+a.Digest, b.Platform.Architecture+"/"+b.Platform.Variant+"/"+b.Digest)
	})
	return repo
}

func (s *Scraper) object(ctx context.Context, repository, kind, digest string) ([]byte, error) {
	body, err := s.Store.ReadObject(kind, digest)
	if err == nil {
		return body, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	endpoint := "manifests"
	if kind == "config" {
		endpoint = "blobs"
	}
	body, _, err = s.Client.Fetch(ctx, repository, endpoint, digest)
	if err != nil {
		return nil, err
	}
	if err := s.Store.WriteObject(kind, digest, body); err != nil {
		return nil, err
	}
	return body, nil
}

func (s *Scraper) resolve(ctx context.Context, repository, digest string, body []byte, platform Platform, depth int, visited map[string]bool) ([]Image, error) {
	if depth > 4 || visited[digest] {
		return nil, errors.New("registry manifest index is too deep or cyclic")
	}
	visited[digest] = true
	defer delete(visited, digest)
	var m manifest
	if err := json.Unmarshal(body, &m); err != nil {
		return nil, err
	}
	if m.SchemaVersion != 2 {
		return nil, errors.New("unsupported registry manifest schema")
	}
	// An empty index is valid and has no config or filesystem to index.
	// Distinguish it from an image manifest whose config is missing.
	if m.Manifests != nil {
		var images []Image
		for _, desc := range m.Manifests {
			p := desc.Platform
			if p.OS != "" && p.OS != "linux" {
				continue
			}
			if p.Architecture != "" && p.Architecture != "amd64" && p.Architecture != "arm64" {
				continue
			}
			if p.OS == "" {
				p.OS = platform.OS
			}
			if p.Architecture == "" {
				p.Architecture = platform.Architecture
			}
			if p.Variant == "" {
				p.Variant = platform.Variant
			}
			child, err := s.object(ctx, repository, "manifest", desc.Digest)
			if err != nil {
				return images, err
			}
			found, err := s.resolve(ctx, repository, desc.Digest, child, p, depth+1, visited)
			if err != nil {
				return images, err
			}
			images = append(images, found...)
		}
		return images, nil
	}
	if m.Config.Digest == "" {
		return nil, errors.New("image manifest has no config digest")
	}
	config, err := s.object(ctx, repository, "config", m.Config.Digest)
	if err != nil {
		return nil, err
	}
	var cfg imageConfig
	if err := json.Unmarshal(config, &cfg); err != nil {
		return nil, err
	}
	if cfg.OS != "linux" || (cfg.Architecture != "amd64" && cfg.Architecture != "arm64") {
		return nil, nil
	}
	if (platform.Architecture != "" && platform.Architecture != cfg.Architecture) || (platform.OS != "" && platform.OS != cfg.OS) {
		return nil, errors.New("manifest platform disagrees with config")
	}
	if platform.Variant == "" {
		platform.Variant = cfg.Variant
	}
	platform.OS, platform.Architecture = cfg.OS, cfg.Architecture
	if len(cfg.RootFS.DiffIDs) != len(m.Layers) {
		return nil, errors.New("image layer and DiffID counts differ")
	}
	layers := make([]Layer, 0, len(m.Layers))
	for i, desc := range m.Layers {
		if !digestPattern.MatchString(desc.Digest) || !digestPattern.MatchString(cfg.RootFS.DiffIDs[i]) {
			return nil, errors.New("invalid layer digest or DiffID")
		}
		layers = append(layers, Layer{Digest: desc.Digest, DiffID: cfg.RootFS.DiffIDs[i], MediaType: desc.MediaType, Size: desc.Size})
	}
	return []Image{{Repository: repository, Digest: digest, ConfigDigest: m.Config.Digest, Platform: platform, Layers: layers, Labels: cfg.Config.Labels, Annotations: m.Annotations, Created: cfg.Created, Entrypoint: cfg.Config.Entrypoint, Cmd: cfg.Config.Cmd, WorkingDir: cfg.Config.WorkingDir, User: cfg.Config.User, FetchedAt: time.Now()}}, nil
}
