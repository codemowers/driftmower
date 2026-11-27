package scanner

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/codemowers/driftmower/internal/gzipstore"
	"github.com/codemowers/driftmower/internal/lifecycle"
)

const packagesSuffix = ".packages" + artifactSuffix

type Package struct {
	ID        string    `json:"id"`
	PURL      string    `json:"purl"`
	Name      string    `json:"name"`
	Ecosystem string    `json:"ecosystem"`
	Version   string    `json:"version,omitempty"`
	Paths     []string  `json:"paths,omitempty"`
	Licenses  []string  `json:"licenses,omitempty"`
	Findings  []Finding `json:"findings,omitempty"`
}
type ArtifactPackages struct {
	Coverage    string    `json:"coverage"`
	Reason      string    `json:"reason,omitempty"`
	ScannedAt   string    `json:"scannedAt,omitempty"`
	Packages    []Package `json:"packages"`
	WithoutPURL int       `json:"withoutPurl"`
}

func extractPackages(body []byte) (*ArtifactPackages, error) {
	var bom struct {
		Format     string         `json:"bomFormat"`
		Properties []ScanProperty `json:"properties"`
		Metadata   struct {
			Timestamp string `json:"timestamp"`
		} `json:"metadata"`
		Components []struct {
			Type       string         `json:"type"`
			Name       string         `json:"name"`
			PURL       string         `json:"purl"`
			Version    string         `json:"version"`
			Properties []ScanProperty `json:"properties"`
			Licenses   []struct {
				License    *struct{ ID, Name string } `json:"license"`
				Expression string                     `json:"expression"`
			} `json:"licenses"`
		} `json:"components"`
	}
	if err := json.Unmarshal(body, &bom); err != nil {
		return nil, err
	}
	if bom.Format != "CycloneDX" {
		return nil, fmt.Errorf("invalid CycloneDX artifact")
	}
	findings, err := extractFindings(bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	out := &ArtifactPackages{Packages: []Package{}, ScannedAt: bom.Metadata.Timestamp}
	out.Coverage, out.Reason, _ = ScanCoverage(bom.Properties)
	byPURL := map[string]*Package{}
	for _, c := range bom.Components {
		if c.Type == "file" || c.Type == "operating-system" {
			continue
		}
		if c.PURL == "" {
			out.WithoutPURL++
			continue
		}
		id := lifecycle.Identity(c.PURL)
		eco, name, ok := strings.Cut(strings.TrimPrefix(id, "pkg:"), "/")
		if !ok || !strings.HasPrefix(id, "pkg:") {
			continue
		}
		p := byPURL[c.PURL]
		if p == nil {
			p = &Package{ID: id, PURL: c.PURL, Name: name, Ecosystem: eco, Version: c.Version}
			byPURL[c.PURL] = p
		}
		for _, v := range c.Properties {
			if v.Name == "aquasecurity:trivy:FilePath" && !slices.Contains(p.Paths, v.Value) {
				p.Paths = append(p.Paths, v.Value)
			}
		}
		for _, l := range c.Licenses {
			value := l.Expression
			if l.License != nil {
				value = l.License.ID
				if value == "" {
					value = l.License.Name
				}
			}
			if value != "" && !slices.Contains(p.Licenses, value) {
				p.Licenses = append(p.Licenses, value)
			}
		}
	}
	for _, f := range findings.Findings {
		if p := byPURL[f.PURL]; p != nil {
			p.Findings = append(p.Findings, f)
		}
	}
	for _, p := range byPURL {
		slices.Sort(p.Paths)
		slices.Sort(p.Licenses)
		out.Packages = append(out.Packages, *p)
	}
	slices.SortFunc(out.Packages, func(a, b Package) int { return strings.Compare(a.PURL, b.PURL) })
	return out, nil
}

type storedPackages struct {
	Modified int64 `json:"modified"`
	Size     int64 `json:"size"`
	ArtifactPackages
}

// Disk projection is owned and evicted with its SBOM. No package cache in memory.
func (c *Controller) packages(key string) (*ArtifactPackages, error) {
	c.artifacts.Lock()
	defer c.artifacts.Unlock()
	path := filepath.Join(c.Config.CacheDir, key+artifactSuffix)
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	cachePath := filepath.Join(c.Config.CacheDir, key+packagesSuffix)
	if body, err := gzipstore.Read(cachePath, MaxSBOMBytes); err == nil {
		var stored storedPackages
		if json.Unmarshal(body, &stored) == nil && stored.Modified == info.ModTime().UnixNano() && stored.Size == info.Size() {
			return &stored.ArtifactPackages, nil
		}
	}
	body, err := gzipstore.Read(path, MaxSBOMBytes)
	if err != nil {
		return nil, err
	}
	out, err := extractPackages(body)
	if err != nil {
		return nil, err
	}
	stored, err := json.Marshal(storedPackages{Modified: info.ModTime().UnixNano(), Size: info.Size(), ArtifactPackages: *out})
	if err != nil {
		return nil, err
	}
	if err = gzipstore.Write(cachePath, stored); err != nil {
		return nil, err
	}
	if c.Config.MaxBytes > 0 {
		if err = c.makeRoomFor(0, key); err != nil {
			_ = os.Remove(cachePath)
			return nil, err
		}
	}
	return out, nil
}
func (c *Controller) servePackages(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if _, err := c.authenticated(r, c.Config.readerServiceAccount()); err != nil {
		http.Error(w, "unauthorized", 401)
		return
	}
	var in struct {
		IncludeDetails bool     `json:"includeDetails,omitempty"`
		Keys           []string `json:"keys"`
		PURL           string   `json:"purl,omitempty"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&in); err != nil {
		http.Error(w, "invalid package request", 400)
		return
	}
	out := map[string]*ArtifactPackages{}
	failures := map[string]string{}
	for _, key := range slices.Compact(slices.Sorted(slices.Values(in.Keys))) {
		if len(key) != 64 || strings.Trim(key, "0123456789abcdef") != "" {
			http.Error(w, "invalid artifact key", 400)
			return
		}
		p, err := c.packages(key)
		if errors.Is(err, os.ErrNotExist) {
			failures[key] = "expired"
			continue
		}
		if err != nil {
			failures[key] = "unavailable"
			continue
		}
		copy := *p
		copy.Packages = []Package{}
		for _, row := range p.Packages {
			if in.PURL != "" && row.ID != in.PURL {
				continue
			}
			if in.PURL == "" && !in.IncludeDetails {
				row.Paths = nil
				row.Licenses = nil
				for i := range row.Findings {
					row.Findings[i].Title = ""
					row.Findings[i].Links = nil
					row.Findings[i].Target = ""
				}
			}
			copy.Packages = append(copy.Packages, row)
		}
		out[key] = &copy
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"artifacts": out, "failures": failures})
}
