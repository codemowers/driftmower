package scanner

import (
	"encoding/json"
	"github.com/prometheus/client_golang/prometheus"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestArtifactCoverageAndVersionsSurviveSummary(t *testing.T) {
	for _, reason := range []string{"", PartialScanReason} {
		body, err := AnnotateArtifact([]byte(`{"bomFormat":"CycloneDX","metadata":{"tools":{"components":[{"name":"trivy","version":"0.75.0"}]}},"components":[{"name":"retained"}],"vulnerabilities":[{"id":"CVE-1"}]}`), "2026-11-15T06:00:00Z", reason)
		if err != nil {
			t.Fatal(err)
		}
		var bom map[string]json.RawMessage
		if err = json.Unmarshal(body, &bom); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(bom["components"]), "retained") {
			t.Fatal("components lost")
		}
		summary, err := summarizeVulnerabilities(strings.NewReader(string(body)))
		if err != nil {
			t.Fatal(err)
		}
		coverage := "complete"
		if reason != "" {
			coverage = "partial"
		}
		if summary.Coverage != coverage || summary.Reason != reason || summary.TrivyVersion != "0.75.0" || summary.DBVersion != "2026-11-15T06:00:00Z" {
			t.Fatalf("provenance lost: %+v", summary)
		}
	}
	summary, err := summarizeVulnerabilities(strings.NewReader(`{"bomFormat":"CycloneDX"}`))
	if err != nil || summary.Coverage != "unknown" {
		t.Fatal("legacy artifact must not claim known coverage", summary, err)
	}
}

func TestFinishedScanMetricsCarryVersionsAndPartialCoverage(t *testing.T) {
	c, _, key := testController(t, 1)
	c.ready.Store(true)
	body, err := AnnotateArtifact([]byte(`{"bomFormat":"CycloneDX","metadata":{"tools":{"components":[{"name":"trivy","version":"0.75.0"}]}},"vulnerabilities":[{"id":"CVE-1"}]}`), "2026-11-15T06:00:00Z", PartialScanReason)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(c.Config.CacheDir, key+".json"), body, 0600); err != nil {
		t.Fatal(err)
	}
	if err = c.summarizeArtifact(key); err != nil {
		t.Fatal(err)
	}
	reg := prometheus.NewRegistry()
	reg.MustRegister(&securityCollector{c})
	families, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, family := range families {
		switch family.GetName() {
		case "driftmower_image_scan_state", "driftmower_image_scan_available", "driftmower_image_scan_accepted_timestamp_seconds", "driftmower_image_vulnerabilities":
			checked++
			for _, metric := range family.Metric {
				labels := map[string]string{}
				for _, label := range metric.Label {
					labels[label.GetName()] = label.GetValue()
				}
				if labels["trivy_version"] != "0.75.0" || labels["db_version"] != "2026-11-15T06:00:00Z" || labels["coverage"] != "partial" || labels["reason"] != PartialScanReason {
					t.Fatal("missing provenance", labels)
				}
				if family.GetName() == "driftmower_image_scan_state" && labels["state"] != "partial" {
					t.Fatal("partial scan reported done", labels)
				}
			}
		}
	}
	if checked != 4 {
		t.Fatal("expected existing metric families", checked)
	}
}
