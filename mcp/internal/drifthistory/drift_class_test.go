package drifthistory

import "testing"

func TestDriftClass(t *testing.T) {
	for _, tc := range []struct {
		version, latest string
		behind          int
		want            string
	}{
		{"1.2.3", "1.2.3", 0, "current"},
		{"1.2.3", "1.2.5", 2, "patch"},
		{"v1.2.3", "v1.4.0", 3, "minor"},
		{"1.2.3", "2.0.0", 9, "major"},
		{"1.2", "1.2.1", 1, "patch"},
		{"1.2.3", "nightly", 1, "behind"},
	} {
		if got := driftClass(tc.version, tc.latest, tc.behind); got != tc.want {
			t.Errorf("driftClass(%q, %q) = %q, want %q", tc.version, tc.latest, got, tc.want)
		}
	}
}
