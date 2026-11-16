package crawler

import (
	"context"
	"errors"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Forge kinds the crawler reads releases from.
const (
	GitHub = "github"
	GitLab = "gitlab"
	Gitea  = "gitea"
)

// Release is a published release of a source, or a Git tag when it has no releases.
type Release struct {
	Notes      string    `json:"notes,omitempty"`
	Tag        string    `json:"tag"`
	Prerelease bool      `json:"prerelease,omitempty"`
	Published  time.Time `json:"published,omitzero"`
	URL        string    `json:"url,omitempty"`
}

// Range is the affected range of one package as an advisory states it.
type Range struct {
	Package string   `json:"package,omitempty"`
	Range   string   `json:"range"`
	Patched []string `json:"patched,omitempty"`
}

// Advisory is a security advisory affecting a source.
type Advisory struct {
	ID        string    `json:"id"`
	Aliases   []string  `json:"aliases,omitempty"`
	Severity  string    `json:"severity,omitempty"`
	Summary   string    `json:"summary,omitempty"`
	URL       string    `json:"url,omitempty"`
	Published time.Time `json:"published,omitzero"`
	Modified  time.Time `json:"modified,omitzero"`
	// Origin is reviewed (GitHub's advisory database), repository (the
	// maintainers' own advisory, free-text ranges) or osv.
	Origin string  `json:"origin"`
	Ranges []Range `json:"ranges,omitempty"`
}

// location splits a canonical source URL into its forge and repository path.
type location struct {
	url, host, path, forge string
}

func locate(raw string, giteaHosts []string) (location, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return location{}, false
	}
	loc := location{url: raw, host: u.Host, path: strings.Trim(u.Path, "/")}
	segments := strings.Count(loc.path, "/") + 1
	switch {
	case u.Host == "github.com" && segments == 2:
		loc.forge = GitHub
	case u.Host == "gitlab.com" && segments >= 2:
		loc.forge = GitLab
	case (u.Host == "codeberg.org" || u.Host == "gitea.com" || slices.Contains(giteaHosts, u.Host)) && segments == 2:
		loc.forge = Gitea
	default:
		return loc, false
	}
	return loc, true
}

func (c *Crawler) releases(ctx context.Context, loc location) ([]Release, error) {
	var out []Release
	switch loc.forge {
	case GitHub, Gitea:
		endpoint := c.githubAPIFor(loc) + "/repos/" + loc.path + "/releases?per_page=100"
		if loc.forge == Gitea {
			endpoint = "https://" + loc.host + "/api/v1/repos/" + loc.path + "/releases?limit=50"
		}
		type releaseItem struct {
			Body        string    `json:"body"`
			TagName     string    `json:"tag_name"`
			Draft       bool      `json:"draft"`
			Prerelease  bool      `json:"prerelease"`
			PublishedAt time.Time `json:"published_at"`
			HTMLURL     string    `json:"html_url"`
		}
		var items []releaseItem
		// Asset metadata can make GitHub's 100-release response exceed the
		// bounded HTTP cache. Reduce page size and restart pagination so the
		// same 100 releases, including their notes, remain available.
		pageSize := 100
		for page := 1; len(items) < 100; page++ {
			pageURL := endpoint
			if loc.forge == GitHub && pageSize < 100 {
				pageURL = c.githubAPIFor(loc) + "/repos/" + loc.path + "/releases?per_page=" + strconv.Itoa(pageSize) + "&page=" + strconv.Itoa(page)
			}
			var batch []releaseItem
			if err := c.fetchFor(loc).getJSON(ctx, pageURL, &batch); err != nil {
				if loc.forge == GitHub && errors.Is(err, errResponseTooLarge) && pageSize > 1 {
					pageSize /= 2
					items = nil
					page = 0
					continue
				}
				if errors.Is(err, errNotFound) && page == 1 {
					break // No published releases; verify the repository through its tags.
				}
				return nil, err
			}
			items = append(items, batch...)
			if loc.forge != GitHub || len(batch) < pageSize {
				break
			}
		}
		if len(items) > 100 {
			items = items[:100]
		}
		for _, item := range items {
			if !item.Draft {
				out = append(out, Release{Notes: item.Body, Tag: item.TagName, Prerelease: item.Prerelease, Published: item.PublishedAt, URL: item.HTMLURL})
			}
		}
	case GitLab:
		var items []struct {
			Description     string    `json:"description"`
			TagName         string    `json:"tag_name"`
			ReleasedAt      time.Time `json:"released_at"`
			UpcomingRelease bool      `json:"upcoming_release"`
			Links           struct {
				Self string `json:"self"`
			} `json:"_links"`
		}
		endpoint := "https://gitlab.com/api/v4/projects/" + url.PathEscape(loc.path) + "/releases?per_page=100"
		if err := c.fetchFor(loc).getJSON(ctx, endpoint, &items); err != nil && !errors.Is(err, errNotFound) {
			return nil, err
		}
		for _, item := range items {
			out = append(out, Release{Notes: item.Description, Tag: item.TagName, Prerelease: item.UpcomingRelease, Published: item.ReleasedAt, URL: item.Links.Self})
		}
	}
	// Empty or unavailable release collections fall back to repository tags.
	// Authentication, throttling and transport failures remain errors.
	if len(out) == 0 {
		var endpoint, tagURL string
		switch loc.forge {
		case GitHub:
			endpoint = c.githubAPIFor(loc) + "/repos/" + loc.path + "/tags?per_page=100"
			tagURL = loc.url + "/tree/"
		case Gitea:
			endpoint = "https://" + loc.host + "/api/v1/repos/" + loc.path + "/tags?limit=50"
			tagURL = loc.url + "/src/tag/"
		case GitLab:
			endpoint = "https://gitlab.com/api/v4/projects/" + url.PathEscape(loc.path) + "/repository/tags?per_page=100"
			tagURL = loc.url + "/-/tags/"
		}
		if endpoint != "" {
			var tags []struct {
				Name string `json:"name"`
			}
			if err := c.fetchFor(loc).getJSON(ctx, endpoint, &tags); err != nil {
				return nil, err
			}
			for _, tag := range tags {
				out = append(out, Release{Tag: tag.Name, URL: tagURL + url.PathEscape(tag.Name)})
			}
		}
	}
	for i := range out {
		if v, ok := ParseVersion(out[i].Tag); ok && v.Prerelease != "" {
			out[i].Prerelease = true
		}
	}
	return out, nil
}

type githubVulnerability struct {
	Package struct {
		Ecosystem string `json:"ecosystem"`
		Name      string `json:"name"`
	} `json:"package"`
	VulnerableVersionRange string `json:"vulnerable_version_range"`
	// PatchedVersions is set by repository advisories, FirstPatchedVersion
	// by reviewed ones.
	PatchedVersions     string `json:"patched_versions"`
	FirstPatchedVersion string `json:"first_patched_version"`
}

type githubAdvisory struct {
	GHSAID          string                `json:"ghsa_id"`
	CVEID           string                `json:"cve_id"`
	HTMLURL         string                `json:"html_url"`
	Summary         string                `json:"summary"`
	Severity        string                `json:"severity"`
	PublishedAt     time.Time             `json:"published_at"`
	UpdatedAt       time.Time             `json:"updated_at"`
	Vulnerabilities []githubVulnerability `json:"vulnerabilities"`
}

// githubAdvisories returns a GitHub repository's published advisories, with
// ranges from GitHub's reviewed advisory database where it has them.
func (c *Crawler) githubAdvisories(ctx context.Context, loc location) ([]Advisory, error) {
	var items []githubAdvisory
	err := c.fetchFor(loc).getJSON(ctx, c.githubAPIFor(loc)+"/repos/"+loc.path+"/security-advisories?per_page=100&state=published", &items)
	if errors.Is(err, errNotFound) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	var out []Advisory
	for _, item := range items {
		advisory := Advisory{ID: item.GHSAID, Severity: normalizeSeverity(item.Severity), Summary: item.Summary, URL: item.HTMLURL,
			Published: item.PublishedAt, Modified: item.UpdatedAt, Origin: "repository"}
		if item.CVEID != "" {
			advisory.Aliases = []string{item.CVEID}
		}
		vulnerabilities := item.Vulnerabilities
		var reviewed githubAdvisory
		if err := c.fetchFor(loc).getJSON(ctx, c.githubAPIFor(loc)+"/advisories/"+item.GHSAID, &reviewed); err == nil && len(reviewed.Vulnerabilities) > 0 {
			advisory.Origin, vulnerabilities = "reviewed", reviewed.Vulnerabilities
		} else if err != nil && !errors.Is(err, errNotFound) {
			return nil, err
		}
		for _, v := range vulnerabilities {
			r := Range{Package: v.Package.Ecosystem + ":" + v.Package.Name, Range: v.VulnerableVersionRange}
			for _, patched := range append(strings.Split(v.PatchedVersions, ","), v.FirstPatchedVersion) {
				if patched = strings.TrimSpace(patched); patched != "" {
					r.Patched = append(r.Patched, patched)
				}
			}
			advisory.Ranges = append(advisory.Ranges, r)
		}
		out = append(out, advisory)
	}
	return out, nil
}

type osvVulnerability struct {
	ID               string    `json:"id"`
	Summary          string    `json:"summary"`
	Aliases          []string  `json:"aliases"`
	Published        time.Time `json:"published"`
	Modified         time.Time `json:"modified"`
	DatabaseSpecific struct {
		Severity string `json:"severity"`
	} `json:"database_specific"`
	Affected []struct {
		Package struct {
			Ecosystem string `json:"ecosystem"`
			Name      string `json:"name"`
		} `json:"package"`
		Ranges []struct {
			Type   string `json:"type"`
			Events []struct {
				Introduced   string `json:"introduced"`
				Fixed        string `json:"fixed"`
				LastAffected string `json:"last_affected"`
			} `json:"events"`
		} `json:"ranges"`
	} `json:"affected"`
}

// osvQuery returns OSV advisories affecting a Go module version or a commit;
// OSV does the matching.
func (c *Crawler) osvQuery(ctx context.Context, query map[string]any) ([]Advisory, error) {
	var resp struct {
		Vulns []osvVulnerability `json:"vulns"`
	}
	if err := c.fetch.postJSON(ctx, c.osvURL+"/v1/query", query, &resp); err != nil {
		return nil, err
	}
	var out []Advisory
	for _, vuln := range resp.Vulns {
		advisory := Advisory{ID: vuln.ID, Aliases: vuln.Aliases, Severity: normalizeSeverity(vuln.DatabaseSpecific.Severity), Summary: vuln.Summary,
			URL: "https://osv.dev/vulnerability/" + vuln.ID, Published: vuln.Published, Modified: vuln.Modified, Origin: "osv"}
		for _, affected := range vuln.Affected {
			for _, r := range affected.Ranges {
				var bounds []string
				var patched []string
				for _, event := range r.Events {
					switch {
					case event.Introduced != "" && event.Introduced != "0":
						bounds = append(bounds, ">= "+event.Introduced)
					case event.Fixed != "":
						bounds = append(bounds, "< "+event.Fixed)
						patched = append(patched, event.Fixed)
					case event.LastAffected != "":
						bounds = append(bounds, "<= "+event.LastAffected)
					}
				}
				if r.Type != "GIT" && len(bounds) > 0 {
					advisory.Ranges = append(advisory.Ranges, Range{Package: affected.Package.Ecosystem + ":" + affected.Package.Name,
						Range: strings.Join(bounds, ", "), Patched: patched})
				}
			}
		}
		out = append(out, advisory)
	}
	return out, nil
}

// goModule guesses a source's Go module path for a version: host and path,
// with the /vN suffix Go requires from major version 2.
func goModule(loc location, v Version) string {
	module := loc.host + "/" + loc.path
	if major := v.component(0); major >= 2 {
		module += "/v" + strconv.Itoa(major)
	}
	return module
}

func normalizeSeverity(severity string) string {
	switch s := strings.ToLower(severity); s {
	case "moderate":
		return "medium"
	default:
		return s
	}
}
