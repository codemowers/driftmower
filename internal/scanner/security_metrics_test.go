package scanner

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestVulnerabilitySummaryDeduplicatesAndKeepsUnknownFixes(t *testing.T) {
	body := `{"bomFormat":"CycloneDX","vulnerabilities":[
 {"id":"CVE-1","ratings":[{"severity":"high"}],"affects":[{"ref":"pkg-a"}]},
 {"id":"CVE-1","ratings":[{"severity":"critical"}],"affects":[{"ref":"pkg-a","versions":[{"version":"2","status":"unaffected"}]},{"ref":"pkg-b"}]},
 {"id":"CVE-2","recommendation":"Upgrade lib to version 3","affects":[{"ref":"pkg-c"}]},
 {"id":"CVE-3","ratings":[{"severity":"unexpected"}]},
 {"id":"CVE-resolved","ratings":[{"severity":"critical"}],"analysis":{"state":"not_affected"}}
 ]}`
	s, err := summarizeVulnerabilities(strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	want := map[findingClass]int{{"CRITICAL", "available"}: 1, {"CRITICAL", "unknown"}: 1, {"UNKNOWN", "available"}: 1, {"UNKNOWN", "unknown"}: 1}
	if len(s.Counts) != len(want) {
		t.Fatalf("counts %+v", s.Counts)
	}
	for class, count := range want {
		if s.Counts[class] != count {
			t.Fatalf("class %+v: %+v", class, s.Counts)
		}
	}
	for _, body := range []string{`{"bomFormat":"other"}`, `{"bomFormat":"CycloneDX"} {}`} {
		if _, err := summarizeVulnerabilities(strings.NewReader(body)); err == nil {
			t.Fatal("invalid artifact accepted")
		}
	}
}

func TestScannerSecurityMetricsRecoverAfterRestartAndDisappearOnEviction(t *testing.T) {
	c, _, key := testController(t, 1)
	c.ready.Store(true)
	file := filepath.Join(c.Config.CacheDir, key+artifactSuffix)
	if err := os.WriteFile(file, gzipTestBytes(t, []byte(`{"bomFormat":"CycloneDX","vulnerabilities":[{"id":"CVE-1","ratings":[{"severity":"critical"}]}]}`)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := c.summarizeArtifact(key); err != nil {
		t.Fatal(err)
	}
	if count := testutil.CollectAndCount(&securityCollector{c}, "driftmower_image_vulnerabilities"); count != 1 {
		t.Fatalf("findings %d", count)
	}
	c.summaries.Delete(key) // Only summaries are lost on process restart.
	if _, err := c.summarizeArtifact(key); err != nil {
		t.Fatal(err)
	}
	reg := prometheus.NewRegistry()
	reg.MustRegister(&securityCollector{c})
	families, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	accepted := false
	for _, family := range families {
		if family.GetName() == "driftmower_image_scan_accepted_timestamp_seconds" {
			accepted = family.Metric[0].GetGauge().GetValue() > 0
		}
	}
	if !accepted {
		t.Fatal("artifact acceptance timestamp missing")
	}
	c.Config.MaxBytes = 0
	if err := c.makeRoom(0); err != nil {
		t.Fatal(err)
	}
	if _, ok := c.summaries.Load(key); ok {
		t.Fatal("evicted artifact retained summary")
	}
	if count := testutil.CollectAndCount(&securityCollector{c}, "driftmower_image_vulnerabilities"); count != 0 {
		t.Fatal("evicted findings still exported")
	}
	if err := c.informer.GetStore().Delete(c.informer.GetStore().List()[0]); err != nil {
		t.Fatal(err)
	}
	if count := testutil.CollectAndCount(&securityCollector{c}, "driftmower_image_scan_available"); count != 0 {
		t.Fatal("deleted image still exported")
	}
}

func TestFilesystemMetricSurvivesIncompleteTrivyAndEvictionClearsEvidence(t *testing.T) {
	for _, status := range []string{"pending", "failed", "complete"} {
		t.Run(status, func(t *testing.T) {
			c, _, key := testController(t, 1)
			c.ready.Store(true)
			file := filepath.Join(c.Config.CacheDir, key+artifactSuffix)
			body := `{"bomFormat":"CycloneDX","properties":[{"name":"driftmower:filesystem:schema-version","value":"1"},{"name":"driftmower:scan:vulnerabilities-status","value":"` + status + `"}]}`
			if err := os.WriteFile(file, gzipTestBytes(t, []byte(body)), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := c.summarizeArtifact(key); err != nil {
				t.Fatal(err)
			}
			reg := prometheus.NewRegistry()
			reg.MustRegister(&securityCollector{c})
			check := func(wantFiles, wantTrivy float64) {
				t.Helper()
				families, err := reg.Gather()
				if err != nil {
					t.Fatal(err)
				}
				seen := 0
				for _, family := range families {
					switch family.GetName() {
					case "driftmower_image_filesystem_available":
						seen++
						if family.Metric[0].GetGauge().GetValue() != wantFiles {
							t.Fatalf("filesystem evidence %+v", family)
						}
					case "driftmower_image_scan_available":
						seen++
						if family.Metric[0].GetGauge().GetValue() != wantTrivy {
							t.Fatalf("Trivy evidence %+v", family)
						}
					}
				}
				if seen != 2 {
					t.Fatalf("missing evidence metrics %d", seen)
				}
			}
			wantTrivy := 0.
			if status == "complete" {
				wantTrivy = 1
			}
			check(1, wantTrivy)
			c.summaries.Delete(key)
			if _, err := c.summarizeArtifact(key); err != nil {
				t.Fatal(err)
			}
			check(1, wantTrivy)
			if err := os.Remove(file); err != nil {
				t.Fatal(err)
			}
			check(0, 0)
		})
	}
}
