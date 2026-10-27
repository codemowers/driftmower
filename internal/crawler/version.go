package crawler

import (
	"regexp"
	"strconv"
	"strings"
)

// Version is a parsed release or image version. Prefix is any text before the
// first digit other than a v, such as loki- in loki-3.1.0, so monorepo
// components compare only with themselves.
type Version struct {
	Raw        string
	Prefix     string
	Core       []int
	Prerelease string
}

var (
	versionCore = regexp.MustCompile(`^([0-9]+(?:\.[0-9]+){0,3})(.*)$`)
	// prereleaseSuffix marks suffixes that precede a release; others, such
	// as -alpine or -build2026, are variants of the release.
	prereleaseSuffix = regexp.MustCompile(`^[-.+_]?(alpha|beta|rc|pre|preview|dev|snapshot)[-.0-9]*`)
)

// ParseVersion parses values such as v1.20.0, 1.27.3-alpine, 3.0.0-alpha or
// loki-3.1.0. It reports false when no numeric core is present.
func ParseVersion(raw string) (Version, bool) {
	v := Version{Raw: raw}
	rest := raw
	if i := strings.IndexAny(rest, "0123456789"); i > 0 {
		v.Prefix = rest[:i]
		rest = rest[i:]
	} else if i < 0 {
		return v, false
	}
	if v.Prefix == "v" || v.Prefix == "V" {
		v.Prefix = ""
	}
	match := versionCore.FindStringSubmatch(rest)
	if match == nil {
		return v, false
	}
	for _, part := range strings.Split(match[1], ".") {
		n, err := strconv.Atoi(part)
		if err != nil {
			return v, false
		}
		v.Core = append(v.Core, n)
	}
	if pre := prereleaseSuffix.FindString(strings.ToLower(match[2])); pre != "" {
		v.Prerelease = strings.TrimLeft(pre, "-.+_")
	}
	return v, true
}

func (v Version) component(i int) int {
	if i < len(v.Core) {
		return v.Core[i]
	}
	return 0
}

// Compare orders versions by core, a prerelease before its release.
func (v Version) Compare(o Version) int {
	for i := range max(len(v.Core), len(o.Core)) {
		if a, b := v.component(i), o.component(i); a != b {
			if a < b {
				return -1
			}
			return 1
		}
	}
	switch {
	case v.Prerelease == o.Prerelease:
		return 0
	case v.Prerelease == "":
		return 1
	case o.Prerelease == "":
		return -1
	}
	return comparePrerelease(v.Prerelease, o.Prerelease)
}

func comparePrerelease(a, b string) int {
	as, bs := strings.FieldsFunc(a, separator), strings.FieldsFunc(b, separator)
	for i := range min(len(as), len(bs)) {
		an, aerr := strconv.Atoi(as[i])
		bn, berr := strconv.Atoi(bs[i])
		switch {
		case aerr == nil && berr == nil && an != bn:
			if an < bn {
				return -1
			}
			return 1
		case (aerr != nil || berr != nil) && as[i] != bs[i]:
			return strings.Compare(as[i], bs[i])
		}
	}
	return len(as) - len(bs)
}

func separator(r rune) bool { return r == '.' || r == '-' }

// Line reports whether o is on the same major.minor line as v.
func (v Version) Line(o Version) bool {
	return v.component(0) == o.component(0) && v.component(1) == o.component(1)
}

// Confidence says how sure a match is.
type Confidence string

const (
	Affected Confidence = "affected"
	// Possible means the range admits more than one reading and one of them
	// includes the version.
	Possible Confidence = "possible"
)

type constraint struct {
	op      string
	version Version
}

func parseRange(text string) ([]constraint, bool) {
	var out []constraint
	for _, part := range strings.Split(text, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		op := "="
		for _, candidate := range []string{">=", "<=", ">", "<", "="} {
			if rest, ok := strings.CutPrefix(part, candidate); ok {
				op, part = candidate, strings.TrimSpace(rest)
				break
			}
		}
		v, ok := ParseVersion(part)
		if !ok {
			return nil, false
		}
		out = append(out, constraint{op: op, version: v})
	}
	return out, len(out) > 0
}

func (c constraint) holds(v Version) bool {
	cmp := v.Compare(c.version)
	switch c.op {
	case "<":
		return cmp < 0
	case "<=":
		return cmp <= 0
	case ">":
		return cmp > 0
	case ">=":
		return cmp >= 0
	}
	return cmp == 0
}

// MatchRange evaluates a GitHub-style vulnerable version range. In GitHub's
// grammar comma-separated constraints are ANDed, as in >= 1.18.0, <= 1.20.2.
// Repository advisories are free text and also use commas for alternatives:
// version lists (v1.18.0,v1.18.1) and one upper bound per release branch
// (<v1.12.14,<v1.15.4,<v1.16.2). Those are read per branch: the bound on
// the version's own major.minor line decides, and without one the result is
// at most Possible. It reports false when v is not affected or the range
// cannot be parsed.
func MatchRange(text string, v Version) (Confidence, bool) {
	constraints, ok := parseRange(text)
	if !ok {
		return "", false
	}
	var equals, uppers, lowers int
	for _, c := range constraints {
		switch c.op {
		case "=":
			equals++
		case "<", "<=":
			uppers++
		default:
			lowers++
		}
	}
	switch {
	case equals == len(constraints):
		for _, c := range constraints {
			if c.holds(v) {
				return Affected, true
			}
		}
		return "", false
	case equals == 0 && uppers <= 1 && lowers <= 1:
		for _, c := range constraints {
			if !c.holds(v) {
				return "", false
			}
		}
		return Affected, true
	case equals == 0 && lowers == 0:
		var lowest, highest *constraint
		for i := range constraints {
			c := &constraints[i]
			if c.version.Line(v) {
				if c.holds(v) {
					return Affected, true
				}
				return "", false
			}
			if lowest == nil || c.version.Compare(lowest.version) < 0 {
				lowest = c
			}
			if highest == nil || c.version.Compare(highest.version) > 0 {
				highest = c
			}
		}
		// Older than every fixed line, or between lines without a bound of
		// its own: affected under one reading only.
		if highest.holds(v) {
			return Possible, true
		}
		return "", false
	}
	// Mixed or several lower bounds: affected if any reading includes v.
	for _, c := range constraints {
		if c.holds(v) {
			return Possible, true
		}
	}
	return "", false
}

// FixedIn picks the version to move to from patched versions: the lowest
// one above v on its own line, otherwise the lowest one above v.
func FixedIn(patched []string, v Version) string {
	var line, any *Version
	for _, raw := range patched {
		// Repository advisories sometimes state patched versions as a
		// bound. ">= v7.15.2" names a fixed version; "> v7.15.4" names none.
		raw = strings.TrimSpace(raw)
		if strings.HasPrefix(raw, ">") && !strings.HasPrefix(raw, ">=") {
			continue
		}
		raw = strings.TrimSpace(strings.TrimLeft(raw, ">=~^ "))
		p, ok := ParseVersion(raw)
		if !ok || p.Compare(v) <= 0 {
			continue
		}
		if p.Line(v) && (line == nil || p.Compare(*line) < 0) {
			line = &p
		}
		if any == nil || p.Compare(*any) < 0 {
			any = &p
		}
	}
	switch {
	case line != nil:
		return line.Raw
	case any != nil:
		return any.Raw
	}
	return ""
}
