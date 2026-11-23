package scanner

import (
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const findingsBOM = `{"bomFormat":"CycloneDX","metadata":{"timestamp":"2026-11-01T00:00:00Z","tools":{"components":[{"name":"trivy","version":"0.60.0"}]}},
"components":[{"bom-ref":"pkg:deb/openssl@3.0","name":"openssl","version":"3.0","purl":"pkg:deb/openssl@3.0","properties":[{"name":"aquasecurity:trivy:FilePath","value":"/usr/lib"}]},{"bom-ref":"pkg:golang/clean@1","name":"clean","version":"1"}],
"vulnerabilities":[
 {"id":"CVE-1","description":"` + "x" + `","ratings":[{"severity":"high","score":7.5},{"severity":"critical","score":9.8}],"advisories":[{"url":"https://example.org/CVE-1"}],"affects":[{"ref":"pkg:deb/openssl@3.0","versions":[{"version":"3.1","status":"unaffected"}]}]},
 {"id":"CVE-1","affects":[{"ref":"pkg:deb/openssl@3.0"}]},
 {"id":"CVE-2","ratings":[{"severity":"low"}],"recommendation":"Upgrade openssl to version 3.2","affects":[{"ref":"pkg:deb/openssl@3.0"}]},
 {"id":"CVE-3","analysis":{"state":"not_affected"},"affects":[{"ref":"pkg:deb/openssl@3.0"}]}]}`

func TestExtractFindingsKeepsOnlyAffectedPackages(t *testing.T) {
	out, err := extractFindings(strings.NewReader(findingsBOM))
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Findings) != 2 || out.TrivyVersion != "0.60.0" {
		t.Fatalf("findings = %+v", out)
	}
	first := out.Findings[0]
	if first.ID != "CVE-1" || first.Severity != "CRITICAL" || first.Score != 9.8 || first.Package != "openssl" || first.Target != "/usr/lib" || first.Fixed != "3.1" || len(first.Links) != 1 {
		t.Fatalf("CVE-1 = %+v", first)
	}
	if out.Findings[1].Fixed != "3.2" || out.Findings[1].Severity != "LOW" {
		t.Fatalf("CVE-2 = %+v", out.Findings[1])
	}
}

func TestFindingsSidecarFollowsTheArtifact(t *testing.T) {
	dir := t.TempDir()
	c := &Controller{Config: Config{CacheDir: dir}}
	key := strings.Repeat("a", 64)
	write := func(body string, modified time.Time) {
		var buf bytes.Buffer
		w := gzip.NewWriter(&buf)
		_, _ = w.Write([]byte(body))
		_ = w.Close()
		path := filepath.Join(dir, key+artifactSuffix)
		if err := os.WriteFile(path, buf.Bytes(), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, modified, modified); err != nil {
			t.Fatal(err)
		}
	}
	write(findingsBOM, time.Unix(100, 0))
	if out, err := c.findings(key); err != nil || len(out.Findings) != 2 {
		t.Fatalf("first read: %+v %v", out, err)
	}
	if _, err := os.Stat(filepath.Join(dir, key+findingsSuffix)); err != nil {
		t.Fatal("findings were not stored beside the artifact")
	}
	write(`{"bomFormat":"CycloneDX"}`, time.Unix(200, 0))
	if out, err := c.findings(key); err != nil || len(out.Findings) != 0 {
		t.Fatalf("a replaced artifact must not reuse stale findings: %+v %v", out, err)
	}
	_ = os.Remove(filepath.Join(dir, key+artifactSuffix))
	if _, err := c.findings(key); err == nil {
		t.Fatal("an evicted artifact must not answer from its findings")
	}
	if _, err := os.Stat(filepath.Join(dir, key+findingsSuffix)); err == nil {
		t.Fatal("orphaned findings were kept")
	}
}
