package crawler

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type browserAuthorizationError struct{ status int }

func (e *browserAuthorizationError) Error() string {
	return fmt.Sprintf("browser authorization HTTP %d", e.status)
}

// BrowserAPI serves reports directly. MCP verifies the existing audience-bound
// browser bearer and list ContainerImages permission; no reports cross that hop.
// The original /v1 API continues to accept projected ServiceAccount tokens.
func BrowserAPI(c *Crawler, authorizeURL string, origins []string) http.Handler {
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	api := &API{Crawler: c, Allowed: []string{"browser"}}
	api.Authenticate = func(ctx context.Context, token string) (string, error) {
		if token == "" {
			return "", errors.New("missing bearer")
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, authorizeURL, nil)
		if err != nil {
			return "", err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := client.Do(req)
		if err != nil {
			return "", &browserAuthorizationError{status: http.StatusServiceUnavailable}
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusNoContent {
			status := resp.StatusCode
			if status != 401 && status != 403 {
				status = http.StatusServiceUnavailable
			}
			return "", &browserAuthorizationError{status: status}
		}
		return "browser", nil
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Add("Vary", "Origin")
		origin := r.Header.Get("Origin")
		if origin != "" {
			allowed := false
			for _, candidate := range origins {
				if candidate == origin {
					allowed = true
				}
			}
			if !allowed {
				http.Error(w, "origin is not allowed", 403)
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}
		if r.Method == http.MethodOptions {
			if r.Header.Get("Access-Control-Request-Method") != "GET" {
				http.Error(w, "method not allowed", 405)
				return
			}
			for _, h := range strings.Split(r.Header.Get("Access-Control-Request-Headers"), ",") {
				if h = strings.ToLower(strings.TrimSpace(h)); h != "" && h != "authorization" && h != "accept" {
					http.Error(w, "header not allowed", 403)
					return
				}
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Accept")
			w.Header().Set("Access-Control-Max-Age", "600")
			w.WriteHeader(204)
			return
		}
		// Cache policy is installed only after API authentication succeeds.
		api.ServeHTTP(w, r)
	})
}
