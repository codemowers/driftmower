package httpcache

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
)

// JSON validates a representation without retaining another copy server-side.
// The caller installs its public/private freshness policy after authorization.
func JSON(w http.ResponseWriter, r *http.Request, value any) {
	body, err := json.Marshal(value)
	if err != nil {
		w.Header().Set("Cache-Control", "no-store")
		http.Error(w, "response encoding failed", 500)
		return
	}
	sum := sha256.Sum256(body)
	etag := `"` + hex.EncodeToString(sum[:]) + `"`
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("ETag", etag)
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		for _, candidate := range strings.Split(r.Header.Get("If-None-Match"), ",") {
			candidate = strings.TrimSpace(candidate)
			if candidate == "*" || strings.TrimPrefix(candidate, "W/") == etag {
				w.WriteHeader(http.StatusNotModified)
				return
			}
		}
	}
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}
