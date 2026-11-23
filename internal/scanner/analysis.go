package scanner

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/codemowers/driftmower/internal/imageanalysis"
)

// Legacy sidecars are recognized only for cache migration/eviction. All new
// filesystem observations live in the primary CycloneDX artifact.
const AnalysisSuffix = ".analysis.json.gz"
const MaxAnalysisBytes = 8 << 20

// Compatibility projection for older MCP instances during an operator rollout;
// this endpoint reads the same CycloneDX file and never persists another report.
func (c *Controller) serveAnalysis(w http.ResponseWriter, r *http.Request) {
	if _, err := c.authenticated(r, c.Config.readerServiceAccount()); err != nil {
		http.Error(w, "unauthorized", 401)
		return
	}
	key := r.PathValue("key")
	if !validArtifactKey(key) {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(filepath.Join(c.Config.CacheDir, key+artifactSuffix))
	if errors.Is(err, os.ErrNotExist) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, "artifact unavailable", 503)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.Size() > MaxCompressedSBOMBytes {
		http.Error(w, "artifact unavailable", 503)
		return
	}
	reader, err := gzip.NewReader(f)
	if err != nil {
		http.Error(w, "artifact unavailable", 503)
		return
	}
	defer reader.Close()
	report, err := imageanalysis.ReadCycloneDX(io.LimitReader(reader, MaxSBOMBytes+1))
	if err != nil {
		http.Error(w, "filesystem evidence unavailable", 404)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Encoding", "gzip")
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("ETag", fmt.Sprintf(`"%s-%d-filesystem"`, key, info.ModTime().UnixNano()))
	writer := gzip.NewWriter(w)
	defer writer.Close()
	_ = json.NewEncoder(writer).Encode(report)
}

func validArtifactKey(key string) bool {
	if len(key) != 64 {
		return false
	}
	for _, r := range key {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}

// A failed vulnerability step leaves its static facts in the same artifact,
// explicitly marked failed rather than looking like a zero-finding result.
func (c *Controller) markArtifactFailed(key, reason string) error {
	c.artifacts.Lock()
	defer c.artifacts.Unlock()
	path := filepath.Join(c.Config.CacheDir, key+artifactSuffix)
	summary, err := readArtifactSummary(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if summary.Status != "pending" {
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	reader, err := gzip.NewReader(f)
	if err != nil {
		f.Close()
		return err
	}
	body, err := io.ReadAll(io.LimitReader(reader, MaxSBOMBytes+1))
	reader.Close()
	f.Close()
	if err != nil {
		return err
	}
	if len(body) > MaxSBOMBytes {
		return fmt.Errorf("oversized pending artifact")
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal(body, &root); err != nil {
		return err
	}
	var properties []imageanalysis.Property
	if err := json.Unmarshal(root["properties"], &properties); err != nil {
		return err
	}
	for i := range properties {
		if properties[i].Name == imageanalysis.VulnerabilityStatusProperty {
			properties[i].Value = "failed"
		}
	}
	properties = append(properties, imageanalysis.Property{Name: imageanalysis.VulnerabilityReasonProperty, Value: reason})
	root["properties"], _ = json.Marshal(properties)
	body, err = json.Marshal(root)
	if err != nil {
		return err
	}
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write(body); err != nil {
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	previous, err := os.Stat(path)
	if err != nil {
		return err
	}
	if err := c.makeRoomFor(int64(compressed.Len())-previous.Size(), key); err != nil {
		return err
	}
	if err := os.WriteFile(path+".tmp", compressed.Bytes(), 0600); err != nil {
		return err
	}
	if err := os.Rename(path+".tmp", path); err != nil {
		return err
	}
	c.summaries.Delete(key)
	_ = os.Remove(filepath.Join(c.Config.CacheDir, key+findingsSuffix))
	return nil
}

// Upgrade recognized legacy sidecars before deleting them, preserving the
// original SBOM metadata, package graph and acceptance time in the merged file.
func (c *Controller) migrateAnalysis(key string) error {
	legacy := filepath.Join(c.Config.CacheDir, key+AnalysisSuffix)
	analysisBody, err := readGzipArtifact(legacy, MaxAnalysisBytes)
	if err != nil {
		return err
	}
	var report imageanalysis.Report
	if err := json.Unmarshal(analysisBody, &report); err != nil {
		return err
	}
	path := filepath.Join(c.Config.CacheDir, key+artifactSuffix)
	body, err := readGzipArtifact(path, MaxSBOMBytes)
	status := "complete"
	stampPath := path
	if errors.Is(err, os.ErrNotExist) {
		body = nil
		status = "pending"
		stampPath = legacy
	} else if err != nil {
		return err
	}
	if len(body) > 0 {
		if _, err := imageanalysis.ReadCycloneDX(bytes.NewReader(body)); err == nil {
			return nil
		}
	}
	merged, err := imageanalysis.MergeCycloneDX(body, report, status)
	if err != nil {
		return err
	}
	if len(merged) > MaxSBOMBytes {
		return fmt.Errorf("legacy merged CycloneDX exceeds artifact size limit")
	}
	stamp, err := os.Stat(stampPath)
	if err != nil {
		return err
	}
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write(merged); err != nil {
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	if err := os.WriteFile(path+".tmp", compressed.Bytes(), 0600); err != nil {
		return err
	}
	if err := os.Rename(path+".tmp", path); err != nil {
		return err
	}
	if err := os.Chtimes(path, stamp.ModTime(), stamp.ModTime()); err != nil {
		return err
	}
	c.summaries.Delete(key)
	_ = os.Remove(filepath.Join(c.Config.CacheDir, key+findingsSuffix))
	return nil
}

func readGzipArtifact(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if info.Size() > limit+(1<<20) {
		return nil, fmt.Errorf("compressed artifact exceeds limit")
	}
	reader, err := gzip.NewReader(f)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	body, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("decompressed artifact exceeds limit")
	}
	return body, nil
}
