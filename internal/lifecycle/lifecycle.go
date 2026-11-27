// Package lifecycle matches observed package identities to upstream support facts.
package lifecycle

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
)

//go:embed defaults.json
var defaults []byte
var numericVersion = regexp.MustCompile(`^[0-9]+(?:\.[0-9]+)*$`)
var productSlug = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

type Rule struct {
	Label    string `json:"label,omitempty"`
	Category string `json:"category,omitempty"`
	Product  string `json:"product"`
	// Optional anchored extraction for versions like release-1.2.3 or distro suffixes.
	VersionPattern     string   `json:"versionPattern,omitempty"`
	VersionReplacement string   `json:"versionReplacement,omitempty"`
	Cycle              string   `json:"cycle,omitempty"`
	Tags               []string `json:"tags,omitempty"`
	Disabled           bool     `json:"disabled,omitempty"`
}
type Product struct {
	Name        string   `json:"name"`
	Label       string   `json:"label"`
	Category    string   `json:"category"`
	Tags        []string `json:"tags"`
	Identifiers []struct {
		Type string `json:"type"`
		ID   string `json:"id"`
	} `json:"identifiers"`
	Releases []Release `json:"releases"`
}
type Release struct {
	ReleaseDate  string `json:"releaseDate"`
	EOASFrom     string `json:"eoasFrom"`
	IsEoas       *bool  `json:"isEoas"`
	Name         string `json:"name"`
	IsEol        *bool  `json:"isEol"`
	EolFrom      string `json:"eolFrom"`
	IsMaintained *bool  `json:"isMaintained"`
	Latest       *struct {
		Name string `json:"name"`
	} `json:"latest"`
}
type Query struct {
	PURL    string `json:"purl"`
	Version string `json:"version,omitempty"`
}

func (q Query) Key() string { return q.PURL + "@" + q.Version }

type Match struct {
	Released         string   `json:"released,omitempty"`
	ActiveSupportEnd string   `json:"activeSupportEnd,omitempty"`
	Product          string   `json:"product"`
	Label            string   `json:"label"`
	Category         string   `json:"category"`
	Tags             []string `json:"tags"`
	URL              string   `json:"url"`
	Mapping          string   `json:"mapping"`
	Cycle            string   `json:"cycle,omitempty"`
	State            string   `json:"state"`
	EOL              string   `json:"eol,omitempty"`
	Latest           string   `json:"latest,omitempty"`
}
type Result struct {
	Matches   map[string]Match `json:"matches,omitempty"`
	CheckedAt time.Time        `json:"checkedAt,omitzero"`
	NextCheck time.Time        `json:"nextCheck,omitzero"`
	Stale     bool             `json:"stale"`
	Errors    []string         `json:"errors,omitempty"`
}

// Identity strips version and occurrence qualifiers, preserving ecosystem and scope.
func Identity(purl string) string {
	base, _, _ := strings.Cut(purl, "?")
	base, _, _ = strings.Cut(base, "#")
	if i := strings.LastIndex(base, "@"); i > strings.LastIndex(base, "/") {
		base = base[:i]
	}
	return base
}
func Rules(overrides []byte) (map[string]Rule, error) {
	rules := map[string]Rule{}
	if err := json.Unmarshal(defaults, &rules); err != nil {
		return nil, err
	}
	if len(overrides) > 0 {
		var extra map[string]Rule
		if err := json.Unmarshal(overrides, &extra); err != nil {
			return nil, err
		}
		for k, v := range extra {
			rules[k] = v
		}
	}
	for p, r := range rules {
		if !strings.HasPrefix(p, "pkg:") || Identity(p) != p {
			return nil, fmt.Errorf("mapping key must be versionless PURL: %s", p)
		}
		if !r.Disabled && r.Product != "" && !productSlug.MatchString(r.Product) {
			return nil, fmt.Errorf("invalid lifecycle product: %s", r.Product)
		}
		if r.VersionPattern != "" {
			if !strings.HasPrefix(r.VersionPattern, "^") || !strings.HasSuffix(r.VersionPattern, "$") {
				return nil, fmt.Errorf("versionPattern must be anchored")
			}
			if _, err := regexp.Compile(r.VersionPattern); err != nil {
				return nil, err
			}
		}
	}
	return rules, nil
}
func Resolve(products []Product, rules map[string]Rule, queries []Query) map[string]Match {
	byName := map[string]*Product{}
	byPURL := map[string][]*Product{}
	for i := range products {
		p := &products[i]
		byName[p.Name] = p
		for _, id := range p.Identifiers {
			if id.Type == "purl" {
				key := Identity(id.ID)
				byPURL[key] = append(byPURL[key], p)
			}
		}
	}
	out := map[string]Match{}
	for _, q := range queries {
		key := Identity(q.PURL)
		rule, custom := rules[key]
		var product *Product
		mapping := "purl"
		if custom {
			if rule.Disabled {
				continue
			}
			product = byName[rule.Product]
			mapping = "mapping"
		} else if len(byPURL[key]) == 1 {
			product = byPURL[key][0]
		}
		if product == nil {
			if custom && rule.Label != "" {
				out[q.Key()] = Match{Label: rule.Label, Category: rule.Category, Tags: append([]string{}, rule.Tags...), Mapping: "mapping", State: "unknown"}
			}
			continue
		}
		tags := append(append([]string{}, product.Tags...), rule.Tags...)
		slices.Sort(tags)
		tags = slices.Compact(tags)
		m := Match{Product: product.Name, Label: product.Label, Category: product.Category, Tags: tags, URL: "https://endoflife.date/" + url.PathEscape(product.Name), Mapping: mapping, State: "unknown"}
		version := strings.TrimPrefix(q.Version, "v")
		if rule.VersionPattern != "" {
			re := regexp.MustCompile(rule.VersionPattern)
			if !re.MatchString(version) {
				out[q.Key()] = m
				continue
			}
			version = re.ReplaceAllString(version, rule.VersionReplacement)
		}
		// Never guess a stable release cycle for prereleases or vendor suffixes.
		if rule.Cycle != "" || numericVersion.MatchString(version) {
			var best *Release
			for i := range product.Releases {
				r := &product.Releases[i]
				cycle := r.Name
				if rule.Cycle != "" {
					if cycle != rule.Cycle {
						continue
					}
				} else if version != cycle && !strings.HasPrefix(version, cycle+".") {
					continue
				}
				if best == nil || len(cycle) > len(best.Name) {
					best = r
				}
			}
			if best != nil {
				m.Cycle = best.Name
				m.EOL = best.EolFrom
				m.Released = best.ReleaseDate
				m.ActiveSupportEnd = best.EOASFrom
				m.State = releaseState(*best, time.Now())
				if best.Latest != nil {
					m.Latest = best.Latest.Name
				}
			}
		}
		out[q.Key()] = m
	}
	return out
}

// Explicit dates continue to advance even while the upstream snapshot has a
// fourteen-day TTL. An absent date never creates a fabricated support phase.
func releaseState(release Release, now time.Time) string {
	reached := func(value string) bool {
		date, err := time.Parse("2006-01-02", value)
		return err == nil && !now.Before(date)
	}
	if reached(release.EolFrom) || (release.IsEol != nil && *release.IsEol) {
		return "end-of-life"
	}
	if reached(release.EOASFrom) || (release.IsEoas != nil && *release.IsEoas) {
		return "maintenance"
	}
	if release.IsEol != nil && !*release.IsEol {
		return "supported"
	}
	return "unknown"
}
