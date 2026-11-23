package scanner

import (
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// findingsSuffix names the derived findings stored beside each artifact. It
// ends like an artifact so cache eviction counts and removes it too.
const findingsSuffix = ".findings" + artifactSuffix

// maxTitle bounds the description carried per finding; the full text stays in
// the SBOM.
const maxTitle = 300

// Finding is one vulnerability in one package of an image.
type Finding struct {
	ID       string   `json:"id"`
	Title    string   `json:"title,omitempty"`
	Severity string   `json:"severity"`
	Score    float64  `json:"score,omitempty"`
	Package  string   `json:"package,omitempty"`
	Version  string   `json:"version,omitempty"`
	PURL     string   `json:"purl,omitempty"`
	Target   string   `json:"target,omitempty"`
	Fixed    string   `json:"fixed,omitempty"`
	Links    []string `json:"links,omitempty"`
}

// ArtifactFindings is the vulnerability view of one scanned artifact: no
// components without findings, hashes or license inventory.
type ArtifactFindings struct {
	Coverage     string    `json:"coverage"`
	TrivyVersion string    `json:"trivyVersion,omitempty"`
	ScannedAt    string    `json:"scannedAt,omitempty"`
	Findings     []Finding `json:"findings"`
}

func extractFindings(r io.Reader) (ArtifactFindings, error) {
	var bom struct {
		Format     string         `json:"bomFormat"`
		Properties []ScanProperty `json:"properties"`
		Metadata   struct {
			Timestamp string `json:"timestamp"`
			Tools     struct {
				Components []struct{ Name, Version string } `json:"components"`
			} `json:"tools"`
		} `json:"metadata"`
		Components []struct {
			Ref        string         `json:"bom-ref"`
			Name       string         `json:"name"`
			Version    string         `json:"version"`
			PURL       string         `json:"purl"`
			Properties []ScanProperty `json:"properties"`
		} `json:"components"`
		Vulnerabilities []struct {
			ID          string `json:"id"`
			Description string `json:"description"`
			Ratings     []struct {
				Severity string  `json:"severity"`
				Score    float64 `json:"score"`
			} `json:"ratings"`
			Recommendation string `json:"recommendation"`
			Advisories     []struct {
				URL string `json:"url"`
			} `json:"advisories"`
			Analysis struct {
				State string `json:"state"`
			} `json:"analysis"`
			Affects []struct {
				Ref      string                             `json:"ref"`
				Versions []struct{ Version, Status string } `json:"versions"`
			} `json:"affects"`
		} `json:"vulnerabilities"`
	}
	if err := json.NewDecoder(r).Decode(&bom); err != nil {
		return ArtifactFindings{}, err
	}
	if bom.Format != "CycloneDX" {
		return ArtifactFindings{}, fmt.Errorf("invalid CycloneDX artifact")
	}
	out := ArtifactFindings{ScannedAt: bom.Metadata.Timestamp, Findings: []Finding{}}
	out.Coverage, _, _ = ScanCoverage(bom.Properties)
	for _, tool := range bom.Metadata.Tools.Components {
		if strings.EqualFold(tool.Name, "trivy") {
			out.TrivyVersion = tool.Version
		}
	}
	type component struct{ name, version, purl, target string }
	components := map[string]component{}
	for _, c := range bom.Components {
		target := ""
		for _, p := range c.Properties {
			if p.Name == "aquasecurity:trivy:FilePath" {
				target = p.Value
			}
		}
		entry := component{c.Name, c.Version, c.PURL, target}
		if c.Ref != "" {
			components[c.Ref] = entry
		}
		if c.PURL != "" {
			components[c.PURL] = entry
		}
	}
	ranks := map[string]int{"UNKNOWN": 0, "NONE": 1, "LOW": 2, "MEDIUM": 3, "HIGH": 4, "CRITICAL": 5}
	seen := map[string]bool{}
	for _, v := range bom.Vulnerabilities {
		switch v.Analysis.State {
		case "not_affected", "resolved", "resolved_with_pedigree", "false_positive":
			continue
		}
		if v.ID == "" {
			continue
		}
		severity, score := "UNKNOWN", 0.0
		for _, rating := range v.Ratings {
			if value := strings.ToUpper(rating.Severity); ranks[value] > ranks[severity] {
				severity = value
			}
			score = max(score, rating.Score)
		}
		title := v.Description
		if len(title) > maxTitle {
			title = strings.ToValidUTF8(title[:maxTitle], "") + "…"
		}
		links := []string{}
		for _, a := range v.Advisories {
			if a.URL != "" && len(links) < 5 {
				links = append(links, a.URL)
			}
		}
		_, recommended, _ := strings.Cut(v.Recommendation, " to version ")
		for _, affected := range v.Affects {
			if seen[v.ID+"\x00"+affected.Ref] {
				continue
			}
			seen[v.ID+"\x00"+affected.Ref] = true
			c, ok := components[affected.Ref]
			if !ok {
				c.name = affected.Ref
			}
			fixed := []string{}
			for _, version := range affected.Versions {
				if version.Status == "unaffected" && version.Version != "" {
					fixed = append(fixed, version.Version)
				}
			}
			fix := strings.Join(fixed, ", ")
			if fix == "" {
				fix = strings.TrimSpace(recommended)
			}
			out.Findings = append(out.Findings, Finding{ID: v.ID, Title: title, Severity: severity, Score: score, Package: c.name, Version: c.version, PURL: c.purl, Target: c.target, Fixed: fix, Links: links})
		}
	}
	return out, nil
}

// findings returns an artifact's findings, deriving and storing them beside the
// artifact on first use. Parsing holds the artifact lock, so one SBOM is in
// memory at a time.
func (c *Controller) findings(key string) (*ArtifactFindings, error) {
	c.artifacts.Lock()
	defer c.artifacts.Unlock()
	artifactPath := filepath.Join(c.Config.CacheDir, key+artifactSuffix)
	findingsPath := filepath.Join(c.Config.CacheDir, key+findingsSuffix)
	artifact, err := os.Stat(artifactPath)
	if err != nil {
		_ = os.Remove(findingsPath)
		return nil, err
	}
	if cached, err := readFindings(findingsPath, artifact.ModTime().Unix()); err == nil {
		return cached, nil
	}
	f, err := os.Open(artifactPath)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	reader, err := gzip.NewReader(f)
	if err != nil {
		return nil, err
	}
	defer func() { _ = reader.Close() }()
	out, err := extractFindings(io.LimitReader(reader, MaxSBOMBytes+1))
	if err != nil {
		return nil, err
	}
	if err := writeFindings(findingsPath, artifact.ModTime().Unix(), &out); err != nil {
		return nil, err
	}
	if c.Config.MaxBytes > 0 {
		if err := c.makeRoomFor(0, key); err != nil {
			_ = os.Remove(findingsPath)
			return nil, err
		}
	}
	return &out, nil
}

type storedFindings struct {
	ArtifactModified int64 `json:"artifactModified"`
	ArtifactFindings
}

func readFindings(path string, modified int64) (*ArtifactFindings, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	reader, err := gzip.NewReader(f)
	if err != nil {
		return nil, err
	}
	defer func() { _ = reader.Close() }()
	var stored storedFindings
	if err := json.NewDecoder(io.LimitReader(reader, MaxSBOMBytes)).Decode(&stored); err != nil {
		return nil, err
	}
	if stored.ArtifactModified != modified {
		return nil, errors.New("findings predate the artifact")
	}
	return &stored.ArtifactFindings, nil
}

func writeFindings(path string, modified int64, findings *ArtifactFindings) error {
	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	writer := gzip.NewWriter(f)
	err = json.NewEncoder(writer).Encode(storedFindings{ArtifactModified: modified, ArtifactFindings: *findings})
	if closeErr := writer.Close(); err == nil {
		err = closeErr
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}
