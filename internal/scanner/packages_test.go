package scanner

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/codemowers/driftmower/internal/gzipstore"
)

const packageBOM = `{"bomFormat":"CycloneDX","properties":[{"name":"driftmower:scan:coverage","value":"partial"},{"name":"driftmower:scan:partial-reason","value":"java_db_unavailable"}],"components":[{"type":"file","name":"/application"},{"type":"library","bom-ref":"types","name":"demo","version":"1.0.0","purl":"pkg:npm/%40types/demo@1.0.0"},{"type":"library","bom-ref":"a","name":"demo","version":"1.0.0","purl":"pkg:npm/demo@1.0.0","properties":[{"name":"aquasecurity:trivy:FilePath","value":"app/node_modules/demo/package.json"}]},{"type":"library","bom-ref":"b","name":"demo","version":"2.0.0","purl":"pkg:npm/demo@2.0.0"},{"type":"library","bom-ref":"no-version","purl":"pkg:golang/example.org/app"}],"vulnerabilities":[{"id":"CVE-example","ratings":[{"severity":"high"}],"affects":[{"ref":"a"}]},{"id":"CVE-resolved","analysis":{"state":"resolved"},"affects":[{"ref":"b"}]}]}`

func TestPackageProjectionKeepsScopesVersionsAndCVEAssociations(t *testing.T) {
	out, err := extractPackages([]byte(packageBOM))
	if err != nil {
		t.Fatal(err)
	}
	if out.Coverage != "partial" || out.Reason != "java_db_unavailable" || len(out.Packages) != 4 {
		t.Fatalf("projection %+v", out)
	}
	for _, p := range out.Packages {
		switch p.PURL {
		case "pkg:npm/demo@1.0.0":
			if len(p.Findings) != 1 || p.Findings[0].ID != "CVE-example" || len(p.Paths) != 1 {
				t.Fatal("lost finding or path")
			}
		case "pkg:npm/demo@2.0.0", "pkg:npm/%40types/demo@1.0.0":
			if len(p.Findings) != 0 {
				t.Fatal("CVE leaked to another scope/version")
			}
		case "pkg:golang/example.org/app":
			if p.Version != "" {
				t.Fatal("guessed missing version")
			}
		}
	}
}
func TestPackageProjectionRebuildAndFamilyEviction(t *testing.T) {
	c := &Controller{Config: Config{CacheDir: t.TempDir()}}
	key := strings.Repeat("a", 64)
	path := filepath.Join(c.Config.CacheDir, key+artifactSuffix)
	if err := gzipstore.Write(path, []byte(packageBOM)); err != nil {
		t.Fatal(err)
	}
	if _, err := c.packages(key); err != nil {
		t.Fatal(err)
	}
	// Same controller is not necessary: the projection survives restart on disk.
	restarted := &Controller{Config: c.Config}
	out, err := restarted.packages(key)
	if err != nil || len(out.Packages) != 4 {
		t.Fatal("restart lost projection", err)
	}
	if err := gzipstore.Write(path, []byte(`{"bomFormat":"CycloneDX","components":[]}`)); err != nil {
		t.Fatal(err)
	}
	out, err = c.packages(key)
	if err != nil || len(out.Packages) != 0 {
		t.Fatal("replacement reused stale packages", err)
	}
	c.Config.MaxBytes = 1
	c.artifacts.Lock()
	err = c.makeRoom(0)
	c.artifacts.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{artifactSuffix, packagesSuffix} {
		if _, err := os.Stat(filepath.Join(c.Config.CacheDir, key+suffix)); !os.IsNotExist(err) {
			t.Fatalf("orphaned %s", suffix)
		}
	}
	if _, err := c.packages(key); !os.IsNotExist(err) {
		t.Fatal("evicted artifact appeared scanned")
	}
}
