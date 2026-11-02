package httpserver

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strings"

	"github.com/codemowers/driftmower/mcp/internal/metrics"
)

const invalidatePath = "/api/cache/invalidate"

// Invalidator is a second freshness channel beside the RBAC watch, for what a
// watch cannot see: a webhook authorizer whose policy changed, an operator who
// wants a flush, an Argo CD PostSync hook. A caller is allowed in with the
// shared secret, or with a Kubernetes token that a TokenReview resolves to one
// of the allowed subjects.
type Invalidator struct {
	SharedToken     string
	AllowedSubjects []string
	// Resolves a Kubernetes token to its username; "" when unauthenticated.
	ReviewToken func(ctx context.Context, token string) (string, error)
	// Prefix applied to an OIDC `sub` to form the Kubernetes username.
	UsernamePrefix string

	ClearReviews        func() int
	InvalidateNamespace func(namespace string) int
	InvalidateUser      func(user string) int
	// Drops cached cluster facts; may be nil.
	InvalidateFacts func()

	Metrics *metrics.Metrics
	Logger  *slog.Logger
}

const maxInvalidateBody = 4096

func (v *Invalidator) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})

		return
	}
	if v.SharedToken == "" && len(v.AllowedSubjects) == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not_found"})

		return
	}

	token, ok := bearerToken(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{
			"error":             "invalid_request",
			"error_description": "An Authorization: Bearer <token> header is required",
		})

		return
	}
	caller := v.authorise(r.Context(), token)
	if caller == "" {
		writeJSON(w, http.StatusForbidden, map[string]string{
			"error":             "forbidden",
			"error_description": "The token is not accepted for cache invalidation",
		})

		return
	}

	var body struct {
		Scope     string `json:"scope"`
		Namespace string `json:"namespace"`
		Sub       string `json:"sub"`
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxInvalidateBody))
	var tooLarge *http.MaxBytesError
	switch {
	case errors.As(err, &tooLarge):
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "body_too_large"})

		return
	case err != nil:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_body"})

		return
	case len(strings.TrimSpace(string(raw))) > 0 && json.Unmarshal(raw, &body) != nil:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})

		return
	}

	var cleared int
	var scope string
	switch body.Scope {
	case "all":
		cleared = v.ClearReviews()
		if v.InvalidateFacts != nil {
			v.InvalidateFacts()
		}
		scope = "all"
	case "namespace":
		if body.Namespace == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing_namespace"})

			return
		}
		cleared = v.InvalidateNamespace(body.Namespace)
		scope = "namespace=" + body.Namespace
	case "identity":
		if body.Sub == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing_sub"})

			return
		}
		cleared = v.InvalidateUser(v.UsernamePrefix + body.Sub)
		scope = "identity=" + body.Sub
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error":             "invalid_scope",
			"error_description": "scope must be 'all', 'namespace' or 'identity'",
		})

		return
	}

	v.Metrics.Invalidations.WithLabelValues("webhook").Inc()
	v.Logger.Info("Cache invalidated", "source", "webhook", "scope", scope, "by", caller, "cleared", cleared)
	writeJSON(w, http.StatusOK, map[string]any{"cleared": cleared, "scope": body.Scope})
}

// authorise returns who the token belongs to, or "" when it is not accepted.
func (v *Invalidator) authorise(ctx context.Context, token string) string {
	if v.SharedToken != "" && subtle.ConstantTimeCompare([]byte(token), []byte(v.SharedToken)) == 1 {
		return "shared-token"
	}
	if len(v.AllowedSubjects) > 0 && v.ReviewToken != nil {
		user, err := v.ReviewToken(ctx, token)
		if err == nil && user != "" && slices.Contains(v.AllowedSubjects, user) {
			return user
		}
	}

	return ""
}

func bearerToken(r *http.Request) (string, bool) {
	scheme, token, ok := strings.Cut(r.Header.Get("Authorization"), " ")
	token = strings.TrimSpace(token)
	if !ok || !strings.EqualFold(scheme, "Bearer") || token == "" || strings.Contains(token, " ") {
		return "", false
	}

	return token, true
}
