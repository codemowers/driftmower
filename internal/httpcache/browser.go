// Package httpcache sets private browser freshness without retaining responses.
package httpcache

import (
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Private expires every response at the next evaluation boundary, even when
// generating it took most of the interval. Errors should instead use no-store.
func Private(h http.Header, started, now, tokenExpiry time.Time, interval time.Duration) {
	var varies bool
	for _, line := range h.Values("Vary") {
		for _, name := range strings.Split(line, ",") {
			if strings.EqualFold(strings.TrimSpace(name), "Authorization") {
				varies = true
			}
		}
	}
	if !varies {
		h.Add("Vary", "Authorization")
	}
	if interval <= 0 {
		h.Set("Cache-Control", "no-store")
		return
	}
	expires := started.Truncate(interval).Add(interval)
	if !tokenExpiry.IsZero() && tokenExpiry.Before(expires) {
		expires = tokenExpiry
	}
	age := max(0, int(expires.Sub(now)/time.Second))
	h.Set("Cache-Control", "private, max-age="+strconv.Itoa(age)+", must-revalidate")
	h.Set("Expires", expires.UTC().Format(http.TimeFormat))
}
