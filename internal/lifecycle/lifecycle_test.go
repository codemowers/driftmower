package lifecycle

import (
	"encoding/json"
	"testing"
	"time"
)

func TestIdentityScopeAndQualifiers(t *testing.T) {
	for input, want := range map[string]string{"pkg:npm/%40types/express@5.0.0": "pkg:npm/%40types/express", "pkg:deb/debian/openssl@3.0?arch=amd64&distro=debian-12": "pkg:deb/debian/openssl", "pkg:golang/example.org/mod/v2@v2.3.0": "pkg:golang/example.org/mod/v2"} {
		if got := Identity(input); got != want {
			t.Fatalf("%s: %s", input, got)
		}
	}
}
func TestResolveExactIdentitiesCyclesAndOverrides(t *testing.T) {
	var products []Product
	if err := json.Unmarshal([]byte(`[{"name":"demo","label":"Demo","category":"framework","tags":["framework"],"identifiers":[{"type":"purl","id":"pkg:npm/demo"}],"releases":[{"name":"1","isEol":true},{"name":"1.2","isEol":false,"eolFrom":"2030-01-01","latest":{"name":"1.2.9"}}]}]`), &products); err != nil {
		t.Fatal(err)
	}
	rules, err := Rules([]byte(`{"pkg:golang/example.org/demo":{"product":"demo","versionPattern":"^release-([0-9.]+)$","versionReplacement":"${1}"},"pkg:npm/ignored":{"disabled":true}}`))
	if err != nil {
		t.Fatal(err)
	}
	queries := []Query{{"pkg:npm/demo", "v1.2.3"}, {"pkg:npm/demo", "1.20.0"}, {"pkg:npm/demo", "1.2.3-rc1"}, {"pkg:npm/%40types/demo", "1.2.3"}, {"pkg:golang/example.org/demo", "release-1.2.4"}}
	out := Resolve(products, rules, queries)
	if out[queries[0].Key()].Cycle != "1.2" || out[queries[0].Key()].State != "supported" || out[queries[0].Key()].Latest != "1.2.9" {
		t.Fatalf("cycle match %+v", out)
	}
	if out[queries[1].Key()].Cycle != "1" {
		t.Fatal("matched 1.2 against 1.20")
	}
	if out[queries[2].Key()].State != "unknown" {
		t.Fatal("prerelease incorrectly treated as stable")
	}
	if _, ok := out[queries[3].Key()]; ok {
		t.Fatal("package scope ignored")
	}
	if out[queries[4].Key()].Cycle != "1.2" {
		t.Fatal("version override not applied")
	}
	if _, err := Rules([]byte(`{"pkg:npm/a":{"product":"demo","versionPattern":"(.*)"}}`)); err == nil {
		t.Fatal("unanchored rule accepted")
	}
}
func TestUnmappedAmbiguousAndClassificationOnly(t *testing.T) {
	var products []Product
	_ = json.Unmarshal([]byte(`[{"name":"a","identifiers":[{"type":"purl","id":"pkg:npm/same"}]},{"name":"b","identifiers":[{"type":"purl","id":"pkg:npm/same"}]}]`), &products)
	rules, _ := Rules(nil)
	q := Query{"pkg:npm/same", "1"}
	out := Resolve(products, rules, []Query{q, {"pkg:pypi/flask", "3.0"}})
	if _, ok := out[q.Key()]; ok {
		t.Fatal("ambiguous product was guessed")
	}
	flask := out[Query{"pkg:pypi/flask", "3.0"}.Key()]
	if flask.Category != "framework" || flask.URL != "" || flask.State != "unknown" {
		t.Fatalf("classification-only rule %+v", flask)
	}
}

func TestLifecycleDatesAdvanceWithinCachedSnapshot(t *testing.T) {
	yes, no := true, false
	now := time.Date(2030, 6, 1, 0, 0, 0, 0, time.UTC)
	if got := releaseState(Release{IsEol: &no, EolFrom: "2030-05-01"}, now); got != "end-of-life" {
		t.Fatal("cached false flag hid reached EOL", got)
	}
	if got := releaseState(Release{IsEol: &no, EOASFrom: "2030-05-01", EolFrom: "2031-01-01"}, now); got != "maintenance" {
		t.Fatal("missing maintenance stage", got)
	}
	if got := releaseState(Release{IsEol: &no, EOASFrom: "2030-12-01", EolFrom: "2031-01-01"}, now); got != "supported" {
		t.Fatal("premature maintenance", got)
	}
	if got := releaseState(Release{IsEol: &yes}, now); got != "end-of-life" {
		t.Fatal("boolean-only EOL lost", got)
	}
	if got := releaseState(Release{}, now); got != "unknown" {
		t.Fatal("missing lifecycle became supported", got)
	}
}
