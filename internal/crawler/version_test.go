package crawler

import "testing"

func version(t *testing.T, raw string) Version {
	t.Helper()
	v, ok := ParseVersion(raw)
	if !ok {
		t.Fatalf("ParseVersion(%q) failed", raw)
	}
	return v
}

func TestParseVersion(t *testing.T) {
	for raw, want := range map[string]Version{
		"v1.20.0":              {Core: []int{1, 20, 0}},
		"1.27.3-alpine":        {Core: []int{1, 27, 3}},
		"3.0.0-alpha":          {Core: []int{3, 0, 0}, Prerelease: "alpha"},
		"1.13.0-alpha.0":       {Core: []int{1, 13, 0}, Prerelease: "alpha.0"},
		"v2.0.0-rc.1":          {Core: []int{2, 0, 0}, Prerelease: "rc.1"},
		"loki-3.1.0":           {Prefix: "loki-", Core: []int{3, 1, 0}},
		"v0.13.3-build2026":    {Core: []int{0, 13, 3}},
		"20230311-deb12u1.5":   {Core: []int{20230311}},
		"v26.3.1-71-g03afae5e": {Core: []int{26, 3, 1}},
	} {
		got := version(t, raw)
		if got.Prefix != want.Prefix || got.Prerelease != want.Prerelease || len(got.Core) != len(want.Core) {
			t.Errorf("ParseVersion(%q) = %+v, want %+v", raw, got, want)
			continue
		}
		for i := range want.Core {
			if got.Core[i] != want.Core[i] {
				t.Errorf("ParseVersion(%q) = %+v, want %+v", raw, got, want)
			}
		}
	}
	for _, raw := range []string{"latest", "main", ""} {
		if _, ok := ParseVersion(raw); ok {
			t.Errorf("ParseVersion(%q) succeeded", raw)
		}
	}
}

func TestCompare(t *testing.T) {
	for _, tc := range []struct {
		a, b string
		want int
	}{
		{"1.20.0", "v1.20.0", 0},
		{"1.20.0", "1.20.3", -1},
		{"1.13.0-alpha.0", "1.13.0", -1},
		{"1.13.0-alpha.2", "1.13.0-alpha.10", -1},
		{"1.13.0-beta.0", "1.13.0-alpha.1", 1},
		{"1.27", "1.27.0", 0},
		{"1.27.3-alpine", "1.27.3", 0},
	} {
		if got := version(t, tc.a).Compare(version(t, tc.b)); got != tc.want {
			t.Errorf("Compare(%s, %s) = %d, want %d", tc.a, tc.b, got, tc.want)
		}
	}
}

// Ranges as GitHub serves them for advisories of sources on ee-lte-1.
func TestMatchRange(t *testing.T) {
	for _, tc := range []struct {
		rng, version string
		want         Confidence
	}{
		// Reviewed and well-formed repository ranges.
		{">= 1.18.0, <= 1.20.2", "v1.20.0", Affected},
		{">= 1.18.0, <= 1.20.2", "v1.20.3", ""},
		{">= 1.18.0, <= 1.20.2", "v1.17.9", ""},
		{"<= v2.11.59", "v3.7.6", ""},
		{">= v3.0.0, <= v3.7.15", "v3.7.6", Affected},
		{">= v3.7.11, <= v3.7.14", "v3.7.6", ""},
		{"= 2.1.20", "v2.1.21", ""},
		{"<= 2.1.21", "v2.1.21", Affected},
		{">= 1.13.0-alpha.0, < 1.15.4", "v1.15.3", Affected},
		{"< 26.6.5", "26.5.5", Affected},
		// Explicit version lists.
		{"v1.18.0,v1.18.1,v1.18.2,v1.19.0", "v1.19.0", Affected},
		{"v1.18.0,v1.18.1,v1.18.2,v1.19.0", "v1.20.0", ""},
		// One upper bound per release branch.
		{"<v1.12.14,<v1.15.4,<v1.16.2", "v1.15.3", Affected},
		{"<v1.12.14,<v1.15.4,<v1.16.2", "v1.15.4", ""},
		{"<v1.12.14,<v1.15.4,<v1.16.2", "v1.20.0", ""},
		{"<v1.12.14,<v1.15.4,<v1.16.2", "v1.14.0", Possible},
		// Unparsable ranges match nothing.
		{"all versions", "v1.0.0", ""},
	} {
		got, _ := MatchRange(tc.rng, version(t, tc.version))
		if got != tc.want {
			t.Errorf("MatchRange(%q, %s) = %q, want %q", tc.rng, tc.version, got, tc.want)
		}
	}
}

func TestFixedIn(t *testing.T) {
	for _, tc := range []struct {
		patched []string
		version string
		want    string
	}{
		{[]string{"1.19.6", "1.20.3"}, "v1.20.0", "1.20.3"},
		{[]string{"v1.16.2", "v1.15.4", "v1.12.14"}, "v1.14.0", "v1.15.4"},
		{[]string{"2.1.22"}, "v2.1.21", "2.1.22"},
		{[]string{"1.0.0"}, "v2.0.0", ""},
		{[]string{"> v7.15.4", ">= 7.15.2"}, "v7.8.1", "7.15.2"},
		{[]string{"> v7.15.4"}, "v7.8.1", ""},
	} {
		if got := FixedIn(tc.patched, version(t, tc.version)); got != tc.want {
			t.Errorf("FixedIn(%v, %s) = %q, want %q", tc.patched, tc.version, got, tc.want)
		}
	}
}
