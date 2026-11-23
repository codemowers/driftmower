package imageanalysis

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

func sampleReport() Report {
	modified := time.Date(2018, 9, 28, 17, 5, 8, 0, time.UTC)
	return Report{SchemaVersion: SchemaVersion, ObservedAt: "2026-11-20T00:00:00Z", NewestFileLimit: NewestFileLimit, Entries: 3, Files: 2, Directories: 1, MIME: map[string]int{"application/octet-stream": 1, "text/plain; charset=utf-8": 1}, LinkingCounts: map[string]int{"static": 1}, Tools: map[string][]string{"busybox": {"/bin/busybox"}}, LatestFileModifiedAt: &modified, LatestFilePath: "/server", NewestFiles: []File{{Path: "/server", ModifiedAt: modified, Size: 123, MIME: "application/octet-stream"}, {Path: "/readme", ModifiedAt: modified.Add(-time.Hour), Size: 20, MIME: "text/plain; charset=utf-8"}}, Binaries: []Binary{{Path: "/server", Linking: "static", Architecture: "EM_X86_64"}}, Shells: []Shell{{Path: "/bin/sh", ResolvedPath: "/bin/busybox"}}}
}

func TestMergedCycloneDXRoundTripAndPreservesTrivyGraph(t *testing.T) {
	report := sampleReport()
	original := []byte(`{"bomFormat":"CycloneDX","specVersion":"1.6","version":1,"metadata":{"timestamp":"2026-11-20T01:00:00Z","component":{"type":"container","name":"image"}},"properties":[{"name":"driftmower:scan:coverage","value":"partial"}],"components":[{"type":"library","bom-ref":"pkg:deb/example@1","name":"example","version":"1"}],"dependencies":[{"ref":"pkg:deb/example@1","dependsOn":[]}],"vulnerabilities":[{"id":"CVE-example","affects":[{"ref":"pkg:deb/example@1"}]}]}`)
	body, err := MergeCycloneDX(original, report, "complete")
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := ReadCycloneDX(bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(*decoded, report) {
		t.Fatalf("filesystem evidence changed:\n%+v\n%+v", *decoded, report)
	}
	var root map[string]json.RawMessage
	_ = json.Unmarshal(body, &root)
	var before map[string]json.RawMessage
	_ = json.Unmarshal(original, &before)
	for _, field := range []string{"metadata", "dependencies", "vulnerabilities"} {
		var a, b any
		_ = json.Unmarshal(root[field], &a)
		_ = json.Unmarshal(before[field], &b)
		if !reflect.DeepEqual(a, b) {
			t.Fatalf("changed original %s", field)
		}
	}
	var components []fileComponent
	_ = json.Unmarshal(root["components"], &components)
	if len(components) != 4 {
		t.Fatalf("file evidence not deduplicated by path: %d", len(components))
	}
	for _, c := range components {
		if c.Type != "file" {
			continue
		}
		for _, p := range c.Properties {
			if !strings.HasPrefix(p.Name, "driftmower:") {
				t.Fatalf("unprefixed extension %q", p.Name)
			}
		}
		if c.Name == "/readme" && c.MIME != "text/plain" {
			t.Fatal("MIME parameters violate CycloneDX mime-type schema")
		}
	}
	if bytes.Contains(body, []byte("latest-modified-path")) || bytes.Contains(body, []byte("latestFilePath")) {
		t.Fatal("duplicated latest file path at top level")
	}
	if _, err := MergeCycloneDX(body, report, "complete"); err == nil {
		t.Fatal("accepted double filesystem enrichment")
	}
}

func TestStaticCycloneDXIsStandaloneAndCannotImplyVulnerabilityCompletion(t *testing.T) {
	body, err := MergeCycloneDX(nil, sampleReport(), "pending")
	if err != nil {
		t.Fatal(err)
	}
	var root struct {
		Format     string     `json:"bomFormat"`
		Properties []Property `json:"properties"`
		Metadata   struct {
			Timestamp string `json:"timestamp"`
		} `json:"metadata"`
	}
	_ = json.Unmarshal(body, &root)
	if root.Format != "CycloneDX" || root.Metadata.Timestamp != "2026-11-20T00:00:00Z" {
		t.Fatal("invalid standalone BOM metadata")
	}
	found := false
	for _, p := range root.Properties {
		if p.Name == VulnerabilityStatusProperty {
			found = p.Value == "pending"
		}
		if p.Name == "driftmower:scan:coverage" && p.Value == "complete" {
			t.Fatal("filesystem-only BOM claimed vulnerability coverage")
		}
	}
	if !found {
		t.Fatal("missing pending vulnerability status")
	}
}

func TestCycloneDXRejectsUnboundedOrUnsupportedFilesystemEvidence(t *testing.T) {
	report := sampleReport()
	report.NewestFileLimit++
	if _, err := MergeCycloneDX(nil, report, "pending"); err == nil {
		t.Fatal("accepted unbounded file retention")
	}
	if _, err := ReadCycloneDX(strings.NewReader(`{"bomFormat":"CycloneDX","properties":[]}`)); err == nil {
		t.Fatal("missing filesystem evidence became a clean report")
	}
}
