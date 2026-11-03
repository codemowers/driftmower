package auth

import (
	"context"
	"net/http"

	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/oauthex"
)

// Authenticator verifies bearer tokens on the HTTP transport: ServiceAccount
// tokens through TokenReview when enabled, everything else through OIDC.
type Authenticator struct {
	OIDC *OIDCVerifier
	// Nil disables ServiceAccount authentication.
	ServiceAccounts *TokenReviewer
	// The protected resource, `<public URL>/mcp`.
	Resource string
	Issuer   string
}

// MetadataPath is where RFC 9728 places the metadata for a resource at path
// /mcp: at the root, with the resource path appended.
const MetadataPath = "/.well-known/oauth-protected-resource/mcp"

// Verify implements the SDK's TokenVerifier.
func (a *Authenticator) Verify(ctx context.Context, token string, _ *http.Request) (*auth.TokenInfo, error) {
	if a.ServiceAccounts != nil {
		_, info, handled, err := a.ServiceAccounts.VerifyServiceAccount(ctx, token, a.Resource)
		if handled {
			return info, err
		}
	}
	_, info, err := a.OIDC.Verify(ctx, token)

	return info, err
}

// Middleware rejects requests without a valid bearer token with 401 and a
// WWW-Authenticate challenge pointing at the resource metadata, which is how an
// OAuth-capable client discovers the flow.
func (a *Authenticator) Middleware(publicURL string) func(http.Handler) http.Handler {
	return auth.RequireBearerToken(a.Verify, &auth.RequireBearerTokenOptions{
		ResourceMetadataURL: publicURL + MetadataPath,
		ClockSkew:           clockSkew,
	})
}

// Metadata is the RFC 9728 protected resource metadata.
func (a *Authenticator) Metadata() *oauthex.ProtectedResourceMetadata {
	return &oauthex.ProtectedResourceMetadata{
		Resource:               a.Resource,
		AuthorizationServers:   []string{a.Issuer},
		BearerMethodsSupported: []string{"header"},
		// A client requests exactly what is listed here, so offline_access has
		// to be among them: without it the issuer grants no refresh token and
		// the connection dies an hour after every sign-in.
		ScopesSupported: []string{"openid", "profile", "email", "groups", "namespaces", "offline_access"},
	}
}
