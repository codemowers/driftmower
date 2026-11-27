package crawler

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/codemowers/driftmower/internal/gzipstore"
)

var errInvalidHTTPCache = errors.New("invalid persisted HTTP cache")

func httpCacheError(err error) error {
	var pathError *os.PathError
	if errors.As(err, &pathError) {
		return err
	}
	return fmt.Errorf("%w: %v", errInvalidHTTPCache, err)
}

func cacheID(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
func downloadCategory(raw string) string {
	_, op := fetchLabels(raw)
	switch op {
	case "releases", "tags":
		return "releases"
	case "changelog":
		return "changelogs"
	case "ghsa", "osv":
		return "advisories"
	case "endoflife":
		return "endoflife"
	default:
		return "http"
	}
}

type responseMetadata struct {
	ETag         string    `json:"etag,omitempty"`
	LastModified string    `json:"lastModified,omitempty"`
	BodyHash     string    `json:"bodyHash"`
	CheckedAt    time.Time `json:"checkedAt"`
}

func (f *fetcher) responsePath(raw string) string {
	// Credentials scope private responses, but are never stored in the cache.
	return filepath.Join(f.cacheDir, downloadCategory(raw), cacheID(f.githubBase+"\x00"+f.githubToken+"\x00"+raw)+".json.gz")
}
func (f *fetcher) diskResponse(raw string, limit int64) (cachedResponse, bool, error) {
	path := f.responsePath(raw)
	metadata, err := gzipstore.Read(path+".meta.json.gz", 1<<20)
	if errors.Is(err, os.ErrNotExist) {
		return cachedResponse{}, false, nil
	}
	if err != nil {
		return cachedResponse{}, false, httpCacheError(err)
	}
	var meta responseMetadata
	if err = json.Unmarshal(metadata, &meta); err != nil {
		return cachedResponse{}, false, httpCacheError(err)
	}
	body, err := gzipstore.Read(path, limit)
	if errors.Is(err, os.ErrNotExist) {
		return cachedResponse{}, false, nil
	}
	if err != nil {
		return cachedResponse{}, false, httpCacheError(err)
	}
	// Interrupted two-file writes must never validate a different body with an old ETag.
	if cacheID(string(body)) != meta.BodyHash {
		return cachedResponse{}, false, nil
	}
	return cachedResponse{checkedAt: meta.CheckedAt, etag: meta.ETag, lastModified: meta.LastModified, body: body}, true, nil
}
func (f *fetcher) persistResponse(raw string, compressed, body []byte, etag, modified string) error {
	path := f.responsePath(raw)
	if err := gzipstore.WriteCompressed(path, compressed); err != nil {
		return err
	}
	meta, err := json.Marshal(responseMetadata{ETag: etag, LastModified: modified, BodyHash: cacheID(string(body)), CheckedAt: time.Now().UTC()})
	if err != nil {
		return err
	}
	return gzipstore.Write(path+".meta.json.gz", meta)
}

type storedSource struct {
	URL           string                `json:"url"`
	CheckedAt     time.Time             `json:"checkedAt"`
	Due           time.Time             `json:"due"`
	Errors        []string              `json:"errors,omitempty"`
	Unauthorized  bool                  `json:"unauthorized,omitempty"`
	Releases      []Release             `json:"releases,omitempty"`
	Advisories    []Advisory            `json:"advisories,omitempty"`
	Changelog     *Changelog            `json:"changelog,omitempty"`
	ChangelogText string                `json:"changelogText,omitempty"`
	License       *RepositoryLicense    `json:"license,omitempty"`
	Versions      map[string]bool       `json:"versions,omitempty"`
	Revisions     map[string]bool       `json:"revisions,omitempty"`
	OSV           map[string][]Advisory `json:"osv,omitempty"`
}

func (c *Crawler) sourcePath(url string) string {
	loc, _ := c.locate(url)
	f := c.fetchFor(loc)
	return filepath.Join(c.cfg.CacheDir, "sources", cacheID(f.githubBase+"\x00"+f.githubToken+"\x00"+url)+".json.gz")
}
func (c *Crawler) persistSource(url string, s *sourceState) error {
	if c.cfg.CacheDir == "" {
		return nil
	}
	stored := storedSource{URL: url, CheckedAt: s.checkedAt, Due: s.due, Errors: s.errors, Unauthorized: s.unauthorized, Releases: s.releases, Advisories: s.advisories, Changelog: s.changelog, License: s.license, Versions: s.versions, Revisions: s.revisions, OSV: s.osv}
	if s.changelog != nil {
		stored.ChangelogText = s.changelog.Text
	}
	body, err := json.Marshal(stored)
	if err != nil {
		return err
	}
	return gzipstore.Write(c.sourcePath(url), body)
}
func (c *Crawler) restoreSource(url string) (*sourceState, error) {
	if c.cfg.CacheDir == "" {
		return nil, nil
	}
	body, err := gzipstore.Read(c.sourcePath(url), 64<<20)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var s storedSource
	if err = json.Unmarshal(body, &s); err != nil {
		return nil, err
	}
	if s.URL != url {
		return nil, fmt.Errorf("source cache identity mismatch")
	}
	if s.Changelog != nil {
		s.Changelog.Text = s.ChangelogText
	}
	return &sourceState{checkedAt: s.CheckedAt, due: s.Due, errors: s.Errors, unauthorized: s.Unauthorized, releases: s.Releases, advisories: s.Advisories, changelog: s.Changelog, license: s.License, versions: s.Versions, revisions: s.Revisions, osv: s.OSV}, nil
}

func (f *fetcher) touchResponse(raw string, cached cachedResponse) error {
	meta, err := json.Marshal(responseMetadata{ETag: cached.etag, LastModified: cached.lastModified, BodyHash: cacheID(string(cached.body)), CheckedAt: time.Now().UTC()})
	if err != nil {
		return err
	}
	return gzipstore.Write(f.responsePath(raw)+".meta.json.gz", meta)
}
