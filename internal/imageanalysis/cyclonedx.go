package imageanalysis

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"slices"
	"strconv"
	"strings"
	"time"
)

const FilesystemPrefix = "driftmower:filesystem:"
const VulnerabilityStatusProperty = "driftmower:scan:vulnerabilities-status"
const VulnerabilityReasonProperty = "driftmower:scan:vulnerabilities-reason"

type Property struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}
type fileComponent struct {
	Type       string     `json:"type"`
	Ref        string     `json:"bom-ref"`
	Name       string     `json:"name"`
	MIME       string     `json:"mime-type,omitempty"`
	Properties []Property `json:"properties"`
}

// MergeCycloneDX preserves Trivy's component graph and metadata, adding bounded
// file components and namespaced observations. Labels/config metadata retain
// their independent ContainerImage lifecycle and are not copied into this BOM.
func MergeCycloneDX(body []byte, report Report, status string) ([]byte, error) {
	if report.SchemaVersion != SchemaVersion || report.NewestFileLimit != NewestFileLimit || len(report.NewestFiles) > NewestFileLimit || len(report.Binaries) > 128 || len(report.Shells) > 64 {
		return nil, fmt.Errorf("invalid bounded filesystem report")
	}
	if status != "pending" && status != "complete" {
		return nil, fmt.Errorf("invalid vulnerability phase")
	}
	root := map[string]json.RawMessage{}
	if len(body) == 0 {
		root["bomFormat"] = json.RawMessage(`"CycloneDX"`)
		root["specVersion"] = json.RawMessage(`"1.6"`)
		root["version"] = json.RawMessage(`1`)
		root["metadata"], _ = json.Marshal(map[string]string{"timestamp": report.ObservedAt})
	} else if err := json.Unmarshal(body, &root); err != nil {
		return nil, err
	}
	if string(root["bomFormat"]) != `"CycloneDX"` {
		return nil, fmt.Errorf("invalid CycloneDX artifact")
	}
	var properties []Property
	if raw := root["properties"]; len(raw) > 0 {
		if err := json.Unmarshal(raw, &properties); err != nil {
			return nil, err
		}
	}
	for _, p := range properties {
		if strings.HasPrefix(p.Name, FilesystemPrefix) || p.Name == VulnerabilityStatusProperty {
			return nil, fmt.Errorf("filesystem observations already merged")
		}
	}
	add := func(name string, value any) {
		var s string
		switch v := value.(type) {
		case string:
			s = v
		default:
			b, _ := json.Marshal(value)
			s = string(b)
		}
		properties = append(properties, Property{FilesystemPrefix + name, s})
	}
	add("schema-version", report.SchemaVersion)
	add("observed-at", report.ObservedAt)
	add("entries-examined", report.Entries)
	add("files-observed", report.Files)
	add("directories-observed", report.Directories)
	add("symlinks-observed", report.Symlinks)
	add("truncated", report.Truncated)
	add("newest-file-limit", report.NewestFileLimit)
	add("newest-files-truncated", report.NewestFilesTruncated)
	add("binaries-truncated", report.BinariesTruncated)
	add("mime-counts", report.MIME)
	add("elf-linking-counts", report.LinkingCounts)
	add("tools", report.Tools)
	if len(report.Errors) > 0 {
		add("errors", report.Errors)
	}
	if report.LatestFileModifiedAt != nil {
		add("latest-modified-at", report.LatestFileModifiedAt.UTC().Format(time.RFC3339Nano))
	}
	properties = append(properties, Property{VulnerabilityStatusProperty, status})
	root["properties"], _ = json.Marshal(properties)
	var components []json.RawMessage
	if raw := root["components"]; len(raw) > 0 {
		if err := json.Unmarshal(raw, &components); err != nil {
			return nil, err
		}
	}
	refs := map[string]bool{}
	for _, raw := range components {
		var c struct {
			Ref string `json:"bom-ref"`
		}
		if err := json.Unmarshal(raw, &c); err != nil {
			return nil, err
		}
		if c.Ref != "" {
			refs[c.Ref] = true
		}
	}
	files := map[string]*fileComponent{}
	file := func(path string) *fileComponent {
		if c := files[path]; c != nil {
			return c
		}
		sum := sha256.Sum256([]byte(path))
		c := &fileComponent{Type: "file", Ref: fmt.Sprintf("driftmower:file:%x", sum), Name: path, Properties: []Property{{"driftmower:file:evidence", "true"}}}
		files[path] = c
		return c
	}
	prop := func(c *fileComponent, name string, value any) {
		var s string
		switch v := value.(type) {
		case string:
			s = v
		default:
			b, _ := json.Marshal(value)
			s = string(b)
		}
		c.Properties = append(c.Properties, Property{name, s})
	}
	for _, f := range report.NewestFiles {
		c := file(f.Path)
		prop(c, "driftmower:file:newest", true)
		prop(c, "driftmower:file:modified-at", f.ModifiedAt.UTC().Format(time.RFC3339Nano))
		prop(c, "driftmower:file:size", f.Size)
		if kind, _, err := mime.ParseMediaType(f.MIME); err == nil && strings.Contains(kind, "/") {
			c.MIME = kind
		}
		if f.MIME != c.MIME {
			prop(c, "driftmower:file:detected-mime-type", f.MIME)
		}
	}
	for _, b := range report.Binaries {
		c := file(b.Path)
		prop(c, "driftmower:elf:linking", b.Linking)
		if b.Architecture != "" {
			prop(c, "driftmower:elf:architecture", b.Architecture)
		}
		if b.Interpreter != "" {
			prop(c, "driftmower:elf:interpreter", b.Interpreter)
		}
		if len(b.Needed) > 0 {
			prop(c, "driftmower:elf:needed", b.Needed)
		}
		if b.NeededTruncated {
			prop(c, "driftmower:elf:needed-truncated", true)
		}
		if b.Error != "" {
			prop(c, "driftmower:elf:error", b.Error)
		}
	}
	for _, s := range report.Shells {
		prop(file(s.Path), "driftmower:shell:resolved-path", s.ResolvedPath)
	}
	paths := make([]string, 0, len(files))
	for p := range files {
		paths = append(paths, p)
	}
	slices.Sort(paths)
	for _, p := range paths {
		c := files[p]
		if refs[c.Ref] {
			return nil, fmt.Errorf("duplicate file component reference")
		}
		raw, err := json.Marshal(c)
		if err != nil {
			return nil, err
		}
		components = append(components, raw)
	}
	root["components"], _ = json.Marshal(components)
	return json.Marshal(root)
}

// ReadCycloneDX projects bounded filesystem evidence from CycloneDX. Package
// and vulnerability data are omitted from the returned report.
func ReadCycloneDX(reader io.Reader) (*Report, error) {
	var bom struct {
		Format     string          `json:"bomFormat"`
		Properties []Property      `json:"properties"`
		Components []fileComponent `json:"components"`
	}
	d := json.NewDecoder(reader)
	if err := d.Decode(&bom); err != nil {
		return nil, err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return nil, fmt.Errorf("trailing CycloneDX data")
	}
	if bom.Format != "CycloneDX" {
		return nil, fmt.Errorf("invalid CycloneDX artifact")
	}
	values := map[string]string{}
	for _, p := range bom.Properties {
		if strings.HasPrefix(p.Name, FilesystemPrefix) {
			values[strings.TrimPrefix(p.Name, FilesystemPrefix)] = p.Value
		}
	}
	if values["schema-version"] != strconv.Itoa(SchemaVersion) {
		return nil, fmt.Errorf("filesystem evidence unavailable or unsupported")
	}
	report := &Report{SchemaVersion: SchemaVersion, ObservedAt: values["observed-at"], NewestFiles: []File{}, Binaries: []Binary{}, Shells: []Shell{}, MIME: map[string]int{}, LinkingCounts: map[string]int{}, Tools: map[string][]string{}}
	fields := []struct {
		name   string
		target any
	}{{"entries-examined", &report.Entries}, {"files-observed", &report.Files}, {"directories-observed", &report.Directories}, {"symlinks-observed", &report.Symlinks}, {"truncated", &report.Truncated}, {"newest-file-limit", &report.NewestFileLimit}, {"newest-files-truncated", &report.NewestFilesTruncated}, {"binaries-truncated", &report.BinariesTruncated}, {"mime-counts", &report.MIME}, {"elf-linking-counts", &report.LinkingCounts}, {"tools", &report.Tools}}
	for _, f := range fields {
		if err := json.Unmarshal([]byte(values[f.name]), f.target); err != nil {
			return nil, fmt.Errorf("invalid filesystem property %s: %w", f.name, err)
		}
	}
	if raw := values["errors"]; raw != "" {
		if err := json.Unmarshal([]byte(raw), &report.Errors); err != nil {
			return nil, err
		}
	}
	if raw := values["latest-modified-at"]; raw != "" {
		t, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			return nil, err
		}
		report.LatestFileModifiedAt = &t
	}
	seen := map[string]bool{}
	for _, c := range bom.Components {
		if c.Type != "file" {
			continue
		}
		p := map[string]string{}
		for _, v := range c.Properties {
			p[v.Name] = v.Value
		}
		if p["driftmower:file:evidence"] != "true" {
			continue
		}
		if seen[c.Name] || len(seen) >= NewestFileLimit+128+64 {
			return nil, fmt.Errorf("duplicate or oversized file evidence")
		}
		seen[c.Name] = true
		if p["driftmower:file:newest"] == "true" {
			modified, err := time.Parse(time.RFC3339Nano, p["driftmower:file:modified-at"])
			if err != nil {
				return nil, err
			}
			size, err := strconv.ParseInt(p["driftmower:file:size"], 10, 64)
			if err != nil {
				return nil, err
			}
			kind := c.MIME
			if v, ok := p["driftmower:file:detected-mime-type"]; ok {
				kind = v
			}
			report.NewestFiles = append(report.NewestFiles, File{Path: c.Name, ModifiedAt: modified, Size: size, MIME: kind})
		}
		if linking := p["driftmower:elf:linking"]; linking != "" {
			b := Binary{Path: c.Name, Linking: linking, Architecture: p["driftmower:elf:architecture"], Interpreter: p["driftmower:elf:interpreter"], Error: p["driftmower:elf:error"], NeededTruncated: p["driftmower:elf:needed-truncated"] == "true"}
			if raw := p["driftmower:elf:needed"]; raw != "" {
				if err := json.Unmarshal([]byte(raw), &b.Needed); err != nil {
					return nil, err
				}
			}
			report.Binaries = append(report.Binaries, b)
		}
		if resolved, ok := p["driftmower:shell:resolved-path"]; ok {
			report.Shells = append(report.Shells, Shell{Path: c.Name, ResolvedPath: resolved})
		}
	}
	if report.NewestFileLimit != NewestFileLimit || len(report.NewestFiles) > NewestFileLimit || len(report.Binaries) > 128 || len(report.Shells) > 64 || report.Files < 0 || report.Files > report.Entries || report.Directories < 0 || report.Symlinks < 0 {
		return nil, fmt.Errorf("invalid bounded filesystem evidence")
	}
	slices.SortFunc(report.NewestFiles, func(a, b File) int {
		if a.ModifiedAt.Equal(b.ModifiedAt) {
			return strings.Compare(a.Path, b.Path)
		}
		return b.ModifiedAt.Compare(a.ModifiedAt)
	})
	slices.SortFunc(report.Binaries, func(a, b Binary) int { return strings.Compare(a.Path, b.Path) })
	slices.SortFunc(report.Shells, func(a, b Shell) int { return strings.Compare(a.Path, b.Path) })
	if report.LatestFileModifiedAt != nil {
		for _, f := range report.NewestFiles {
			if f.ModifiedAt.Equal(*report.LatestFileModifiedAt) {
				report.LatestFilePath = f.Path
				break
			}
		}
	}
	return report, nil
}
