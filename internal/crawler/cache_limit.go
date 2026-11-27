package crawler

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// Bound recognized cache files by their compressed size. Old evidence can be
// fetched again. Keep response bodies and validators in the same eviction unit.
func (c *Crawler) pruneCache() error {
	if c.cfg.CacheDir == "" || c.cfg.CacheMaxBytes <= 0 {
		return nil
	}
	type family struct {
		paths    []string
		size     int64
		modified time.Time
	}
	families := map[string]*family{}
	total := int64(0)
	for _, category := range []string{"sources", "releases", "changelogs", "advisories", "http", "endoflife"} {
		dir := filepath.Join(c.cfg.CacheDir, category)
		entries, err := os.ReadDir(dir)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			name := entry.Name()
			if !strings.HasSuffix(name, ".json.gz") {
				continue
			}
			stem := strings.TrimSuffix(strings.TrimSuffix(name, ".meta.json.gz"), ".json.gz")
			if len(stem) != 64 || strings.Trim(stem, "0123456789abcdef") != "" {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			key := category + "/" + stem
			f := families[key]
			if f == nil {
				f = &family{}
				families[key] = f
			}
			f.paths = append(f.paths, filepath.Join(dir, name))
			f.size += info.Size()
			total += info.Size()
			if info.ModTime().After(f.modified) {
				f.modified = info.ModTime()
			}
		}
	}
	list := make([]*family, 0, len(families))
	for _, f := range families {
		list = append(list, f)
	}
	slices.SortFunc(list, func(a, b *family) int { return a.modified.Compare(b.modified) })
	for _, f := range list {
		if total <= c.cfg.CacheMaxBytes {
			break
		}
		for _, path := range f.paths {
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				return fmt.Errorf("evict cache: %w", err)
			}
		}
		total -= f.size
	}
	return nil
}
