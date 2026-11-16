package crawler

import (
	"testing"
)

func categories(items []ChangeItem) []string {
	out := []string{}
	for _, i := range items {
		out = append(out, i.Category)
	}
	return out
}

func TestParseChangesReadsCommonFormats(t *testing.T) {
	notes := `## What's Changed
### Security
* golang.org/x/net v0.61.0: CVE-2026-78661
### Bugfixes
* a later stage whites out the files of an earlier stage
## New Contributors
* @someone made their first contribution
## Changes
- [BUGFIX] TSDB: reject duplicate exemplars
- [FEATURE] PromQL: add integral()
* 875328a fix(deps): bump alpine
* feat!: drop the v1 API
- Fixed a race on shutdown
- Added a --dry-run flag
- Moved the base image to trixie`
	got := categories(ParseChanges(notes))
	want := []string{"security", "bug", "bug", "feature", "bug", "breaking", "bug", "feature", ""}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("item %d: got %v, want %v", i, got, want)
		}
	}
}

func TestChangelogSectionsSplitAtVersionHeadings(t *testing.T) {
	sections := changelogSections("# Changelog\n## [1.2.0] - 2026-01-02\n### Fixed\n- a crash\n## v1.1.0\n- Added x\n")
	if len(ParseChanges(sections["1.2.0"])) != 1 || ParseChanges(sections["1.2.0"])[0].Category != "bug" || sections["1.1.0"] == "" {
		t.Fatalf("%q", sections)
	}
}

func TestChangesListsNewerReleasesOnTheSamePrefix(t *testing.T) {
	c := &Crawler{state: map[string]*sourceState{"https://github.com/a/b": {
		releases: []Release{
			{Tag: "v1.3.0", Notes: "### Security\n- fixed CVE-2026-1"},
			{Tag: "v1.2.0"},
			{Tag: "v1.1.0", Notes: "- Added old"},
			{Tag: "v1.4.0-rc1", Prerelease: true, Notes: "- fix: x"},
		},
		changelog: &Changelog{Path: "CHANGELOG.md", Text: "## 1.2.0\n### Bug fixes\n- a leak\n"},
	}}}
	r, err := c.Changes("https://github.com/a/b", "v1.1.0")
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Versions) != 2 || r.Versions[0].Tag != "v1.3.0" || r.Totals["security"] != 1 || r.Totals["bug"] != 1 || r.Versions[1].From != "CHANGELOG.md" {
		t.Fatalf("%+v", r)
	}
	if _, err := c.Changes("https://github.com/x/y", "v1"); err == nil {
		t.Fatal("unknown source answered")
	}
}
