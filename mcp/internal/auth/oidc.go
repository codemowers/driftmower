package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/modelcontextprotocol/go-sdk/auth"
)

// OIDCOptions configures access-token verification. This server is a pure
// OIDC resource server: it never mints tokens, it only validates RS256 JWT
// access tokens from the configured issuer.
type OIDCOptions struct {
	Issuer  string
	JWKSURI string
	// The RFC 8707 resource indicator matched strictly against `aud`, normally
	// the resource this server advertises. Strictness is load-bearing: without
	// it the ordinary UI access token any browser session holds would open
	// this server.
	Audience        string
	NamespacesClaim string
	// Present the token in this file when fetching the key set, for issuers
	// that are API servers with anonymous auth off. Reread on every fetch so
	// projected-token rotation works.
	JWKSBearerTokenFile string
	// Accepted client IDs (`azp`, else `client_id`); empty accepts any. `aud`
	// alone does not identify the client: an authorization server that mints
	// for any requested resource would put this server's resource in a token
	// for any of its clients.
	AllowedClientIDs []string
	// Claims kube-apiserver maps to a username and groups.
	UsernameClaim string
	GroupsClaim   string
}

// clockSkew tolerates small clock differences with the issuer.
const clockSkew = time.Minute

// OIDCVerifier verifies access tokens against the issuer's published keys.
type OIDCVerifier struct {
	opts     OIDCOptions
	verifier *oidc.IDTokenVerifier
}

func NewOIDCVerifier(opts OIDCOptions) *OIDCVerifier {
	client := &http.Client{Timeout: 5 * time.Second}
	if opts.JWKSBearerTokenFile != "" {
		client.Transport = &fileBearerTransport{file: opts.JWKSBearerTokenFile, next: http.DefaultTransport}
	}
	// The key set caches keys and refetches when a token names an unknown kid.
	keys := oidc.NewRemoteKeySet(oidc.ClientContext(context.Background(), client), opts.JWKSURI)

	return &OIDCVerifier{
		opts: opts,
		verifier: oidc.NewVerifier(opts.Issuer, keys, &oidc.Config{
			ClientID:             opts.Audience,
			SupportedSigningAlgs: []string{oidc.RS256},
			Now:                  func() time.Time { return time.Now().Add(-clockSkew) },
		}),
	}
}

// Verify checks the token and returns the caller it identifies.
func (v *OIDCVerifier) Verify(ctx context.Context, raw string) (*Caller, *auth.TokenInfo, error) {
	token, err := v.verifier.Verify(ctx, raw)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: %v", auth.ErrInvalidToken, err)
	}
	var claims map[string]any
	if err := token.Claims(&claims); err != nil {
		return nil, nil, fmt.Errorf("%w: %v", auth.ErrInvalidToken, err)
	}
	if token.Subject == "" {
		return nil, nil, fmt.Errorf("%w: token is missing a sub claim", auth.ErrInvalidToken)
	}

	clientID := stringClaim(claims["azp"])
	if clientID == "" {
		clientID = stringClaim(claims["client_id"])
	}
	if len(v.opts.AllowedClientIDs) > 0 && !slices.Contains(v.opts.AllowedClientIDs, clientID) {
		return nil, nil, fmt.Errorf("%w: the token was issued to a client this server does not accept", auth.ErrInvalidToken)
	}

	caller := &Caller{
		Sub:      token.Subject,
		ClientID: clientID,
		Email:    stringClaim(claims["email"]),
		Name:     stringClaim(claims["name"]),
	}
	caller.Groups, _ = stringsClaim(claims["groups"])
	caller.Namespaces.Namespaces, caller.Namespaces.Present = stringsClaim(claims[v.opts.NamespacesClaim])
	caller.IdentityClaims.Username = usernameClaim(claims[v.opts.UsernameClaim])
	caller.IdentityClaims.Groups, _ = stringsClaim(claims[v.opts.GroupsClaim])
	if verified, ok := claims["email_verified"].(bool); ok {
		caller.IdentityClaims.EmailVerified = &verified
	}

	return caller, NewTokenInfo(caller, scopes(claims), token.Expiry), nil
}

func stringClaim(v any) string {
	s, _ := v.(string)

	return s
}

// usernameClaim accepts a number, as kube-apiserver does, and treats an empty
// string as missing.
func usernameClaim(v any) string {
	switch v := v.(type) {
	case string:
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case json.Number:
		return v.String()
	}

	return ""
}

// stringsClaim returns the string items of an array claim, and whether the
// claim was an array at all.
func stringsClaim(v any) ([]string, bool) {
	items, ok := v.([]any)
	if !ok {
		return nil, false
	}
	out := []string{}
	for _, item := range items {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}

	return out, true
}

func scopes(claims map[string]any) []string {
	if s, ok := claims["scope"].(string); ok {
		return strings.Fields(s)
	}
	out, _ := stringsClaim(claims["scp"])

	return out
}

type fileBearerTransport struct {
	file string
	next http.RoundTripper
}

func (t *fileBearerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	token, err := os.ReadFile(t.file)
	if err != nil {
		return nil, fmt.Errorf("read JWKS bearer token: %w", err)
	}
	req = req.Clone(req.Context())
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))

	return t.next.RoundTrip(req)
}
