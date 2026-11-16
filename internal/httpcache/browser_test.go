package httpcache

import (
	"net/http"
	"testing"
	"time"
)

func TestPrivateAlignedExpiry(t *testing.T) {
	start := time.Unix(100, 0)
	for _, tc := range []struct {
		name     string
		now, exp time.Time
		interval time.Duration
		want     string
	}{
		{"remaining interval", start.Add(2 * time.Second), time.Time{}, 15 * time.Second, "private, max-age=3, must-revalidate"},
		{"crossed boundary", start.Add(6 * time.Second), time.Time{}, 15 * time.Second, "private, max-age=0, must-revalidate"},
		{"token expires first", start, start.Add(time.Second), 15 * time.Second, "private, max-age=1, must-revalidate"},
		{"disabled", start, time.Time{}, 0, "no-store"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := http.Header{}
			Private(h, start, tc.now, tc.exp, tc.interval)
			if h.Get("Cache-Control") != tc.want || h.Get("Vary") != "Authorization" {
				t.Fatal(h)
			}
		})
	}
}
