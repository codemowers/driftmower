package scanner

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

func artifactFamily(name string) (string, bool) {
	stem := strings.TrimSuffix(name, artifactSuffix)
	if stem == name {
		return "", false
	}
	stem = strings.TrimSuffix(strings.TrimSuffix(strings.TrimSuffix(stem, ".analysis"), ".findings"), ".packages")
	return stem, len(stem) == 64 && strings.Trim(stem, "0123456789abcdef") == ""
}

// Only delete known scanner-generated legacy artifacts and interrupted writes.
// Runs once under the artifact lock before dispatch, never during an upload.
func (c *Controller) cleanupLegacy() error {
	entries, err := os.ReadDir(c.Config.CacheDir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		stem := strings.TrimSuffix(name, ".json")
		legacy := stem != name && len(stem) == 64 && strings.Trim(stem, "0123456789abcdef") == ""
		if strings.HasSuffix(name, AnalysisSuffix) {
			key, owned := artifactFamily(name)
			if owned && key != "" {
				if err := c.migrateAnalysis(key); err != nil {
					return fmt.Errorf("migrate filesystem evidence %s: %w", key, err)
				}
			}
			legacy = legacy || (owned && key != "")
		}
		if strings.HasSuffix(name, ".tmp") {
			stem = strings.TrimSuffix(name, ".tmp")
			_, owned := artifactFamily(stem)
			legacy = legacy || owned || (len(stem) == 64 && strings.Trim(stem, "0123456789abcdef") == "")
		}
		if strings.HasSuffix(name, findingsSuffix) {
			key := strings.TrimSuffix(name, findingsSuffix)
			if len(key) == 64 && strings.Trim(key, "0123456789abcdef") == "" {
				if _, err := os.Stat(filepath.Join(c.Config.CacheDir, key+artifactSuffix)); errors.Is(err, os.ErrNotExist) {
					legacy = true
				} else if err != nil {
					return err
				}
			}
		}
		if legacy {
			if err := os.Remove(filepath.Join(c.Config.CacheDir, name)); err != nil {
				return err
			}
		}
	}
	return nil
}
func (c *Controller) makeRoom(incoming int64) error { return c.makeRoomFor(incoming, "") }

// Evict a CycloneDX artifact and its derived findings together, accounting for
// every compressed byte. The pending/failed artifact retains static evidence.
func (c *Controller) makeRoomFor(incoming int64, protected string) error {
	entries, err := os.ReadDir(c.Config.CacheDir)
	if err != nil {
		return err
	}
	type family struct {
		key      string
		files    []string
		size     int64
		modified time.Time
		primary  bool
	}
	families := map[string]*family{}
	total := incoming
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		key, owned := artifactFamily(entry.Name())
		if !owned {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		f := families[key]
		if f == nil {
			f = &family{key: key, modified: info.ModTime()}
			families[key] = f
		}
		f.files = append(f.files, entry.Name())
		f.size += info.Size()
		total += info.Size()
		if entry.Name() == key+artifactSuffix {
			f.modified = info.ModTime()
			f.primary = true
		} else if !f.primary && info.ModTime().Before(f.modified) {
			f.modified = info.ModTime()
		}
	}
	ordered := make([]*family, 0, len(families))
	for _, f := range families {
		ordered = append(ordered, f)
	}
	slices.SortFunc(ordered, func(a, b *family) int { return a.modified.Compare(b.modified) })
	for _, f := range ordered {
		if total <= c.Config.MaxBytes {
			break
		}
		if f.key == protected {
			continue
		}
		for _, name := range f.files {
			if err := os.Remove(filepath.Join(c.Config.CacheDir, name)); err != nil {
				return err
			}
		}
		c.summaries.Delete(f.key)
		total -= f.size
	}
	if total > c.Config.MaxBytes {
		return fmt.Errorf("artifact family exceeds cache limit")
	}
	return nil
}
