package crawler

import (
	"context"
	"errors"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// Changelog is a repository's changelog file, stored as fetched. It is
// parsed only when changes are asked for.
type Changelog struct {
	Path string `json:"path"`
	URL  string `json:"url"`
	Text string `json:"-"`
}

var changelogName = regexp.MustCompile(`(?i)^(changelog|changes|history|news|releases?)(\.(md|markdown|rst|txt))?$`)

// changelog finds a changelog file in the repository root and fetches it.
// A repository without one is not an error.
func (c *Crawler) changelog(ctx context.Context, loc location) (*Changelog, error) {
	var listURL string
	switch loc.forge {
	case GitHub:
		listURL = c.githubAPIFor(loc) + "/repos/" + loc.path + "/contents/"
	case Gitea:
		listURL = "https://" + loc.host + "/api/v1/repos/" + loc.path + "/contents"
	case GitLab:
		listURL = "https://gitlab.com/api/v4/projects/" + url.PathEscape(loc.path) + "/repository/tree?per_page=100"
	default:
		return nil, nil
	}
	var entries []struct {
		Name string `json:"name"`
		Path string `json:"path"`
		Type string `json:"type"`
	}
	if err := c.fetchFor(loc).getJSON(ctx, listURL, &entries); err != nil {
		if errors.Is(err, errNotFound) {
			return nil, nil
		}
		return nil, err
	}
	for _, e := range entries {
		if (e.Type != "file" && e.Type != "blob") || !changelogName.MatchString(e.Name) {
			continue
		}
		var rawURL, pageURL string
		switch loc.forge {
		case GitHub:
			rawURL, pageURL = c.githubAPIFor(loc)+"/repos/"+loc.path+"/contents/"+url.PathEscape(e.Path), loc.url+"/blob/HEAD/"+e.Path
		case Gitea:
			rawURL, pageURL = "https://"+loc.host+"/api/v1/repos/"+loc.path+"/raw/"+url.PathEscape(e.Path), loc.url+"/src/branch/HEAD/"+e.Path
		case GitLab:
			rawURL, pageURL = "https://gitlab.com/api/v4/projects/"+url.PathEscape(loc.path)+"/repository/files/"+url.PathEscape(e.Path)+"/raw?ref=HEAD", loc.url+"/-/blob/HEAD/"+e.Path
		}
		body, err := c.fetchFor(loc).getRaw(ctx, rawURL)
		if err != nil {
			return nil, err
		}
		return &Changelog{Path: e.Path, URL: pageURL, Text: string(body)}, nil
	}
	return nil, nil
}

// Change categories, most urgent first.
const (
	CategorySecurity = "security"
	CategoryBreaking = "breaking"
	CategoryBug      = "bug"
	CategoryFeature  = "feature"
)

// ChangeItem is one line of release notes or a changelog, with the category
// its heading, tag, prefix or wording gives it; empty when none does.
type ChangeItem struct {
	Category string `json:"category,omitempty"`
	Text     string `json:"text"`
}

// VersionChanges is what one release changed.
type VersionChanges struct {
	Tag       string    `json:"tag"`
	Published time.Time `json:"published,omitzero"`
	URL       string    `json:"url,omitempty"`
	// "release notes" or the changelog's path.
	From   string         `json:"from,omitempty"`
	Counts map[string]int `json:"counts"`
	Items  []ChangeItem   `json:"items"`
}

// ChangesReport lists the stable releases newer than a version, newest
// first, each with its parsed changes.
type ChangesReport struct {
	URL       string           `json:"url"`
	From      string           `json:"from"`
	Changelog *Changelog       `json:"changelog,omitempty"`
	Versions  []VersionChanges `json:"versions"`
	// Totals per category across Versions.
	Totals map[string]int `json:"totals"`
}

var (
	headingLine  = regexp.MustCompile(`^\s*#{1,6}\s*(.+?)\s*#*\s*$`)
	boldHeading  = regexp.MustCompile(`^\s*\*\*([^*]+)\*\*\s*:?\s*$`)
	bulletLine   = regexp.MustCompile(`^\s*[-*+]\s+(.*)`)
	securityRef  = regexp.MustCompile(`(?i)CVE-\d{4}-\d+|GHSA-\w{4}-\w{4}-\w{4}|\bsecurity\b|vulnerab`)
	commitSHA    = regexp.MustCompile(`^[0-9a-f]{7,40}\s+`)
	bracketTag   = regexp.MustCompile(`^\[([A-Za-z]+)\]`)
	commitPrefix = regexp.MustCompile(`^(?:\*\*)?([A-Za-z]+)(?:\([^)]*\))?(!)?:`)
	fixVerb      = regexp.MustCompile(`(?i)^(fix(e[sd])?|resolve[sd]?|correct(ed|s)?)\b`)
	featureVerb  = regexp.MustCompile(`(?i)^(add(ed|s)?|introduc(e|ed|es)|support(s|ed)?|new|implement(ed|s)?|allow(s|ed)?)\b`)
)

// Headings are matched in order: sections that list no changes first, so
// "New Contributors" is not read as features.
var headingCategories = []struct {
	category string
	pattern  *regexp.Regexp
}{
	{"", regexp.MustCompile(`(?i)contributor|installation|download|survey|notice|builder image|docker image|thank|supported version|checksum|assets|full changelog|sha256|container image|binaries|artifacts|packages`)},
	{CategorySecurity, regexp.MustCompile(`(?i)security|vulnerab|cve`)},
	{CategoryBreaking, regexp.MustCompile(`(?i)breaking|incompatib|action required|urgent|deprecat|removal|removed`)},
	{CategoryBug, regexp.MustCompile(`(?i)bug|fix|regression`)},
	{CategoryFeature, regexp.MustCompile(`(?i)feature|enhancement|\bnew\b|added|highlight|improvement|performance|notable`)},
}

var tagCategories = map[string]string{"bugfix": CategoryBug, "bug": CategoryBug, "fix": CategoryBug, "feature": CategoryFeature,
	"enhancement": CategoryFeature, "security": CategorySecurity, "breaking": CategoryBreaking}

var prefixCategories = map[string]string{"fix": CategoryBug, "bugfix": CategoryBug, "hotfix": CategoryBug, "feat": CategoryFeature,
	"perf": CategoryFeature, "security": CategorySecurity, "sec": CategorySecurity}

// headingCategory reports a heading's category and whether its lines list
// changes at all.
func headingCategory(heading string) (string, bool) {
	for _, h := range headingCategories {
		if h.pattern.MatchString(heading) {
			return h.category, h.category != ""
		}
	}
	return "", true
}

// classify gives a line a category: an advisory identifier or the word
// security first, then a [TAG], a conventional-commit prefix (with ! for
// breaking), the section heading, and last the opening verb.
func classify(text, section string) string {
	if securityRef.MatchString(text) {
		return CategorySecurity
	}
	t := commitSHA.ReplaceAllString(text, "")
	if m := bracketTag.FindStringSubmatch(t); m != nil {
		if c, ok := tagCategories[strings.ToLower(m[1])]; ok {
			return c
		}
	}
	if m := commitPrefix.FindStringSubmatch(t); m != nil {
		if m[2] == "!" {
			return CategoryBreaking
		}
		if c, ok := prefixCategories[strings.ToLower(m[1])]; ok {
			return c
		}
	}
	if section != "" {
		return section
	}
	switch {
	case fixVerb.MatchString(t):
		return CategoryBug
	case featureVerb.MatchString(t):
		return CategoryFeature
	}
	return ""
}

// ParseChanges reads the bullet lines of release notes or a changelog
// section, skipping sections that list no changes.
func ParseChanges(text string) []ChangeItem {
	items := []ChangeItem{}
	section, listsChanges := "", true
	for _, line := range strings.Split(text, "\n") {
		if m := headingLine.FindStringSubmatch(line); m != nil {
			section, listsChanges = headingCategory(m[1])
			continue
		}
		if m := boldHeading.FindStringSubmatch(line); m != nil {
			section, listsChanges = headingCategory(m[1])
			continue
		}
		m := bulletLine.FindStringSubmatch(line)
		if m == nil || !listsChanges {
			continue
		}
		items = append(items, ChangeItem{Category: classify(m[1], section), Text: strings.TrimSpace(m[1])})
	}
	return items
}

var versionInHeading = regexp.MustCompile(`^\s*#{1,3}\s*\[?v?(\d+(?:\.\d+)+[^\s\]\)]*)`)

// changelogSections splits a changelog at headings that name a version, such
// as "## [1.2.3] - 2026-01-02" or "# v1.2.3", keyed by that version.
func changelogSections(text string) map[string]string {
	out := map[string]string{}
	current, body := "", []string{}
	flush := func() {
		if current != "" {
			if _, seen := out[current]; !seen {
				out[current] = strings.Join(body, "\n")
			}
		}
	}
	for _, line := range strings.Split(text, "\n") {
		if m := versionInHeading.FindStringSubmatch(line); m != nil {
			flush()
			current, body = m[1], nil
			continue
		}
		body = append(body, line)
	}
	flush()
	return out
}

// Changes reports the stable releases of url newer than from, on from's own
// tag prefix, parsed now from the stored release notes, or from the
// changelog section of that version where the notes list nothing.
func (c *Crawler) Changes(url, from string) (*ChangesReport, error) {
	v, ok := ParseVersion(from)
	if !ok {
		return nil, errors.New("from is not a version")
	}
	c.mu.RLock()
	state := c.state[url]
	c.mu.RUnlock()
	if state == nil {
		return nil, errNotFound
	}
	out := &ChangesReport{URL: url, From: from, Changelog: state.changelog, Versions: []VersionChanges{}, Totals: map[string]int{}}
	var sections map[string]string
	if state.changelog != nil {
		sections = changelogSections(state.changelog.Text)
	}
	for _, r := range stableReleases(state) {
		if r.version.Prefix != v.Prefix || r.version.Compare(v) <= 0 {
			continue
		}
		vc := VersionChanges{Tag: r.Tag, Published: r.Published, URL: r.URL, Counts: map[string]int{}, Items: ParseChanges(r.Notes)}
		if len(vc.Items) > 0 {
			vc.From = "release notes"
		} else if section, ok := sections[strings.TrimPrefix(r.Tag, "v")]; ok {
			vc.Items, vc.From = ParseChanges(section), state.changelog.Path
		}
		for _, item := range vc.Items {
			if item.Category != "" {
				vc.Counts[item.Category]++
				out.Totals[item.Category]++
			}
		}
		out.Versions = append(out.Versions, vc)
	}
	return out, nil
}
