package auth

import (
	"context"
	"net/http"
	"time"

	"github.com/codemowers/driftmower/mcp/internal/authz"
	sdkauth "github.com/modelcontextprotocol/go-sdk/auth"
)

// AnonymousMiddleware attaches a stable anonymous identity using the SDK's
// transport context. Authorization headers are ignored in this explicit mode;
// supplied tokens never become an impersonated identity.
func AnonymousMiddleware(next http.Handler) http.Handler {
	h := sdkauth.RequireBearerToken(func(context.Context, string, *http.Request) (*sdkauth.TokenInfo, error) {
		return NewTokenInfo(&Caller{Sub: "system:anonymous", Kubernetes: &authz.Identity{User: "system:anonymous", Groups: []string{"system:unauthenticated"}}}, nil, time.Time{}), nil
	}, &sdkauth.RequireBearerTokenOptions{AllowMissingExpiration: true})(next)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r = r.Clone(r.Context())
		r.Header.Set("Authorization", "Bearer anonymous")
		h.ServeHTTP(w, r)
	})
}
