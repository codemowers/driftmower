package scanner

import (
	"bytes"
	"encoding/json"
	"github.com/codemowers/driftmower/internal/imageanalysis"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestArtifactExistsDuringConcurrentEviction(t *testing.T) {
	c, _, key := testController(t, 0)
	body := gzipTestBytes(t, []byte(`{"bomFormat":"CycloneDX"}`))
	c.Config.MaxBytes = int64(len(body))
	path := filepath.Join(c.Config.CacheDir, key+artifactSuffix)
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	workers.Add(2)
	go func() {
		defer workers.Done()
		for range 1000 {
			if _, err := c.artifactExists(key); err != nil {
				t.Errorf("read during eviction: %v", err)
				return
			}
		}
	}()
	go func() {
		defer workers.Done()
		for range 1000 {
			c.artifacts.Lock()
			err := c.makeRoom(int64(len(body)))
			if err == nil {
				err = os.WriteFile(path, body, 0600)
			}
			c.artifacts.Unlock()
			if err != nil {
				t.Errorf("replace artifact: %v", err)
				return
			}
		}
	}()
	workers.Wait()
	if exists, err := c.artifactExists(key); err != nil || !exists {
		t.Fatalf("replacement artifact unavailable: %v, %v", exists, err)
	}
}

func TestCacheEvictsArtifactFamilyAndCleansKnownLegacyFiles(t *testing.T) {
	dir := t.TempDir()
	c := &Controller{Config: Config{CacheDir: dir, MaxBytes: 25}}
	old, next := strings.Repeat("a", 64), strings.Repeat("b", 64)
	for _, name := range []string{old + artifactSuffix, old + findingsSuffix, old + AnalysisSuffix, next + artifactSuffix} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(strings.Repeat("x", 10)), 0600); err != nil {
			t.Fatal(err)
		}
		if strings.HasPrefix(name, old) {
			when := time.Now().Add(-time.Hour)
			if err := os.Chtimes(filepath.Join(dir, name), when, when); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := c.makeRoomFor(5, next); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{artifactSuffix, findingsSuffix, AnalysisSuffix} {
		if _, err := os.Stat(filepath.Join(dir, old+suffix)); !os.IsNotExist(err) {
			t.Fatalf("orphan family member retained: %s", suffix)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, next+artifactSuffix)); err != nil {
		t.Fatal("incoming artifact family evicted")
	}
	for _, name := range []string{old + ".json", old + ".tmp", old + AnalysisSuffix + ".tmp", "unrelated.json"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.cleanupLegacy(); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{old + ".json", old + ".tmp", old + AnalysisSuffix + ".tmp"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Fatalf("legacy file retained: %s", name)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "unrelated.json")); err != nil {
		t.Fatal("deleted unknown file")
	}
}

func TestLegacyAnalysisMigratesIntoPrimaryCycloneDX(t *testing.T) {
	c, _, key := testController(t, 0)
	report := mergedTestReport()
	body, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	legacy := filepath.Join(c.Config.CacheDir, key+AnalysisSuffix)
	if err := os.WriteFile(legacy, gzipTestBytes(t, body), 0600); err != nil {
		t.Fatal(err)
	}
	original := filepath.Join(c.Config.CacheDir, key+artifactSuffix)
	if err := os.WriteFile(original, gzipTestBytes(t, []byte(`{"bomFormat":"CycloneDX","specVersion":"1.6","version":1,"metadata":{"timestamp":"2026-11-19T00:00:00Z"},"components":[{"type":"library","name":"original-package"}]}`)), 0600); err != nil {
		t.Fatal(err)
	}
	stamp := time.Now().Add(-time.Hour).Truncate(time.Second)
	if err := os.Chtimes(original, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	if err := c.cleanupLegacy(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatal("legacy sidecar retained")
	}
	merged, err := readGzipArtifact(original, MaxSBOMBytes)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(merged, []byte("original-package")) {
		t.Fatal("migration discarded package graph")
	}
	decoded, err := imageanalysis.ReadCycloneDX(bytes.NewReader(merged))
	if err != nil || decoded.LatestFilePath != "/server" {
		t.Fatalf("migration lost filesystem evidence: %+v %v", decoded, err)
	}
	info, _ := os.Stat(original)
	if !info.ModTime().Equal(stamp) {
		t.Fatal("migration rewrote original acceptance time")
	}
}
