package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	authenticationv1 "k8s.io/api/authentication/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/modelcontextprotocol/go-sdk/auth"

	"github.com/codemowers/driftmower/mcp/internal/authz"
)

const (
	issuer   = "https://auth.example.com"
	resource = "https://mcp.example.com/mcp"
)

type issuerFixture struct {
	key        *rsa.PrivateKey
	jwks       *httptest.Server
	authHeader atomic.Value
}

func newIssuer(t *testing.T) *issuerFixture {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f := &issuerFixture{key: key}
	f.jwks = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.authHeader.Store(r.Header.Get("Authorization"))
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{
			{Key: &key.PublicKey, KeyID: "k1", Use: "sig"},
		}})
	}))
	t.Cleanup(f.jwks.Close)

	return f
}

func (f *issuerFixture) sign(t *testing.T, claims map[string]any) string {
	t.Helper()
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: f.key},
		(&jose.SignerOptions{}).WithHeader("kid", "k1"))
	if err != nil {
		t.Fatal(err)
	}
	base := map[string]any{
		"iss": issuer,
		"aud": resource,
		"sub": "alice-id",
		"exp": time.Now().Add(time.Hour).Unix(),
		"iat": time.Now().Unix(),
	}
	for k, v := range claims {
		if v == nil {
			delete(base, k)
		} else {
			base[k] = v
		}
	}
	raw, err := jwt.Signed(signer).Claims(base).Serialize()
	if err != nil {
		t.Fatal(err)
	}

	return raw
}

func (f *issuerFixture) verifier(opts OIDCOptions) *OIDCVerifier {
	opts.Issuer = issuer
	opts.JWKSURI = f.jwks.URL
	opts.Audience = resource
	if opts.NamespacesClaim == "" {
		opts.NamespacesClaim = "codemowers.io/namespaces"
	}
	if opts.UsernameClaim == "" {
		opts.UsernameClaim = "sub"
	}
	if opts.GroupsClaim == "" {
		opts.GroupsClaim = "groups"
	}

	return NewOIDCVerifier(opts)
}

func TestOIDCVerifierMapsClaims(t *testing.T) {
	f := newIssuer(t)
	v := f.verifier(OIDCOptions{})

	caller, info, err := v.Verify(context.Background(), f.sign(t, map[string]any{
		"azp":                      "claude",
		"email":                    "alice@example.com",
		"groups":                   []any{"devs", 7},
		"codemowers.io/namespaces": []any{"team-a"},
		"scope":                    "openid namespaces",
		"email_verified":           true,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if caller.Sub != "alice-id" || caller.ClientID != "claude" || caller.Email != "alice@example.com" {
		t.Errorf("caller = %+v", caller)
	}
	if !slices.Equal(caller.Groups, []string{"devs"}) || !caller.Namespaces.Present ||
		!slices.Equal(caller.Namespaces.Namespaces, []string{"team-a"}) {
		t.Errorf("groups/namespaces = %v %+v", caller.Groups, caller.Namespaces)
	}
	if caller.IdentityClaims.Username != "alice-id" || caller.IdentityClaims.EmailVerified == nil || !*caller.IdentityClaims.EmailVerified {
		t.Errorf("identity claims = %+v", caller.IdentityClaims)
	}
	if info.UserID != "alice-id" || !slices.Equal(info.Scopes, []string{"openid", "namespaces"}) || info.Expiration.IsZero() {
		t.Errorf("token info = %+v", info)
	}
	if CallerFrom(info) != caller {
		t.Error("CallerFrom does not return the verified caller")
	}

	// A token without the tenancy claim differs from an empty claim.
	caller, _, err = v.Verify(context.Background(), f.sign(t, map[string]any{"codemowers.io/namespaces": nil}))
	if err != nil || caller.Namespaces.Present {
		t.Errorf("missing claim = %+v %v", caller.Namespaces, err)
	}
	caller, _, _ = v.Verify(context.Background(), f.sign(t, map[string]any{"codemowers.io/namespaces": []any{}}))
	if !caller.Namespaces.Present || len(caller.Namespaces.Namespaces) != 0 {
		t.Errorf("empty claim = %+v", caller.Namespaces)
	}
}

func TestOIDCVerifierConfiguredClaims(t *testing.T) {
	f := newIssuer(t)
	v := f.verifier(OIDCOptions{UsernameClaim: "uid", GroupsClaim: "roles"})

	caller, _, err := v.Verify(context.Background(), f.sign(t, map[string]any{"uid": 1001, "roles": []any{"admin"}, "scp": []any{"a"}}))
	if err != nil {
		t.Fatal(err)
	}
	if caller.IdentityClaims.Username != "1001" || !slices.Equal(caller.IdentityClaims.Groups, []string{"admin"}) {
		t.Errorf("identity claims = %+v", caller.IdentityClaims)
	}
}

func TestOIDCVerifierRejects(t *testing.T) {
	f := newIssuer(t)
	v := f.verifier(OIDCOptions{AllowedClientIDs: []string{"claude"}})
	other := newIssuer(t)

	cases := map[string]string{
		"wrong audience":    f.sign(t, map[string]any{"aud": "https://ui.example.com", "azp": "claude"}),
		"wrong issuer":      f.sign(t, map[string]any{"iss": "https://evil.example.com", "azp": "claude"}),
		"expired":           f.sign(t, map[string]any{"exp": time.Now().Add(-2 * time.Minute).Unix(), "azp": "claude"}),
		"missing sub":       f.sign(t, map[string]any{"sub": nil, "azp": "claude"}),
		"unaccepted client": f.sign(t, map[string]any{"azp": "other"}),
		"wrong key":         other.sign(t, map[string]any{"azp": "claude"}),
		"garbage":           "not-a-jwt",
	}
	for name, token := range cases {
		t.Run(name, func(t *testing.T) {
			if _, _, err := v.Verify(context.Background(), token); !errors.Is(err, auth.ErrInvalidToken) {
				t.Errorf("err = %v", err)
			}
		})
	}

	// Within the clock skew an expired token is still accepted.
	if _, _, err := v.Verify(context.Background(), f.sign(t, map[string]any{"exp": time.Now().Add(-30 * time.Second).Unix(), "azp": "claude"})); err != nil {
		t.Errorf("token within skew rejected: %v", err)
	}
	// client_id serves when azp is absent.
	if _, _, err := v.Verify(context.Background(), f.sign(t, map[string]any{"client_id": "claude"})); err != nil {
		t.Errorf("client_id rejected: %v", err)
	}
}

func TestJWKSBearerTokenFile(t *testing.T) {
	f := newIssuer(t)
	file := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(file, []byte("projected-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	v := f.verifier(OIDCOptions{JWKSBearerTokenFile: file})
	if _, _, err := v.Verify(context.Background(), f.sign(t, nil)); err != nil {
		t.Fatal(err)
	}
	if got := f.authHeader.Load(); got != "Bearer projected-token" {
		t.Errorf("JWKS request Authorization = %v", got)
	}
}

func saToken(sub string, aud any) string {
	enc := base64.RawURLEncoding
	payload, _ := json.Marshal(map[string]any{"sub": sub, "aud": aud, "exp": time.Now().Add(time.Hour).Unix()})

	return enc.EncodeToString([]byte(`{"alg":"RS256"}`)) + "." + enc.EncodeToString(payload) + ".sig"
}

func reviewing(status authenticationv1.TokenReviewStatus, err error) (*TokenReviewer, *[]authenticationv1.TokenReviewSpec) {
	client := fake.NewClientset()
	var sent []authenticationv1.TokenReviewSpec
	client.PrependReactor("create", "tokenreviews", func(action k8stesting.Action) (bool, runtime.Object, error) {
		review := action.(k8stesting.CreateAction).GetObject().(*authenticationv1.TokenReview)
		sent = append(sent, review.Spec)
		out := review.DeepCopy()
		out.Status = status

		return true, out, err
	})

	return NewTokenReviewer(client.AuthenticationV1()), &sent
}

func TestServiceAccountAuthentication(t *testing.T) {
	const user = "system:serviceaccount:workers:agent"
	good := authenticationv1.TokenReviewStatus{
		Authenticated: true,
		Audiences:     []string{resource},
		User: authenticationv1.UserInfo{
			Username: user,
			Groups:   []string{"system:serviceaccounts", "system:serviceaccounts:workers", "system:authenticated"},
		},
	}
	r, sent := reviewing(good, nil)

	caller, info, handled, err := r.VerifyServiceAccount(context.Background(), saToken(user, []string{resource}), resource)
	if !handled || err != nil {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if caller.Sub != user || caller.ClientID != serviceAccountClientID || caller.Kubernetes == nil ||
		caller.Kubernetes.Groups[0] != "system:authenticated" || len(caller.Kubernetes.Groups) != 3 {
		t.Errorf("caller = %+v %+v", caller, caller.Kubernetes)
	}
	if info.UserID != user || info.Expiration.IsZero() {
		t.Errorf("info = %+v", info)
	}
	if len(*sent) != 1 || !slices.Equal((*sent)[0].Audiences, []string{resource}) {
		t.Errorf("TokenReview spec = %+v", *sent)
	}

	// Identity is used verbatim, without OIDC prefixes.
	id, err := KubernetesIdentity(caller, Mapping{UsernamePrefix: "issuer#", GroupsPrefix: "oidc:"})
	if err != nil || id.User != user || slices.Contains(id.Groups, "oidc:system:serviceaccounts") {
		t.Errorf("identity = %+v %v", id, err)
	}
}

func TestServiceAccountRouting(t *testing.T) {
	const user = "system:serviceaccount:workers:agent"
	r, sent := reviewing(authenticationv1.TokenReviewStatus{}, nil)

	if _, _, handled, _ := r.VerifyServiceAccount(context.Background(), saToken("alice", resource), resource); handled {
		t.Error("an OIDC token was handled as a ServiceAccount token")
	}
	if _, _, handled, _ := r.VerifyServiceAccount(context.Background(), "garbage", resource); handled {
		t.Error("an undecodable token was handled")
	}
	_, _, handled, err := r.VerifyServiceAccount(context.Background(), saToken(user, "https://kubernetes.default.svc"), resource)
	if !handled || !errors.Is(err, auth.ErrInvalidToken) || len(*sent) != 0 {
		t.Errorf("ordinary API token: handled=%v err=%v reviews=%d", handled, err, len(*sent))
	}
}

func TestServiceAccountReviewFailures(t *testing.T) {
	const user = "system:serviceaccount:workers:agent"
	cases := map[string]authenticationv1.TokenReviewStatus{
		"unauthenticated": {Audiences: []string{resource}, User: authenticationv1.UserInfo{Username: user, Groups: []string{"system:serviceaccounts:workers"}}},
		"audience":        {Authenticated: true, User: authenticationv1.UserInfo{Username: user, Groups: []string{"system:serviceaccounts:workers"}}},
		"not an SA":       {Authenticated: true, Audiences: []string{resource}, User: authenticationv1.UserInfo{Username: "alice", Groups: []string{"system:serviceaccounts:workers"}}},
		"namespace group": {Authenticated: true, Audiences: []string{resource}, User: authenticationv1.UserInfo{Username: user, Groups: []string{"system:serviceaccounts:other"}}},
	}
	for name, status := range cases {
		t.Run(name, func(t *testing.T) {
			r, _ := reviewing(status, nil)
			if _, _, _, err := r.VerifyServiceAccount(context.Background(), saToken(user, resource), resource); !errors.Is(err, auth.ErrInvalidToken) {
				t.Errorf("err = %v", err)
			}
		})
	}
	r, _ := reviewing(authenticationv1.TokenReviewStatus{}, errors.New("apiserver down"))
	if _, _, _, err := r.VerifyServiceAccount(context.Background(), saToken(user, resource), resource); !errors.Is(err, auth.ErrInvalidToken) {
		t.Errorf("review error = %v", err)
	}
}

func TestKubernetesIdentity(t *testing.T) {
	m := Mapping{UsernameClaim: "sub", GroupsClaim: "groups", UsernamePrefix: "issuer#", GroupsPrefix: "oidc:"}
	unverified := false

	if _, err := KubernetesIdentity(nil, m); !errors.Is(err, ErrUnauthenticated) {
		t.Errorf("nil caller err = %v", err)
	}
	id, err := KubernetesIdentity(&Caller{Sub: "s", IdentityClaims: IdentityClaims{Username: "alice", Groups: []string{"devs", "devs"}}}, m)
	if err != nil || id.User != "issuer#alice" || !slices.Equal(id.Groups, []string{"system:authenticated", "oidc:devs"}) {
		t.Errorf("identity = %+v %v", id, err)
	}
	if _, err := KubernetesIdentity(&Caller{Sub: "s"}, Mapping{UsernameClaim: "preferred_username"}); err == nil ||
		!strings.Contains(err.Error(), "'preferred_username'") {
		t.Errorf("missing claim err = %v", err)
	}
	if _, err := KubernetesIdentity(&Caller{Sub: "s", IdentityClaims: IdentityClaims{Username: "a@b", EmailVerified: &unverified}},
		Mapping{UsernameClaim: "email"}); !errors.Is(err, ErrEmailUnverified) {
		t.Errorf("unverified email err = %v", err)
	}

	if got := Describe(authz.Identity{User: "issuer#alice", Groups: []string{"system:authenticated", "devs"}}); got != `Kubernetes user "issuer#alice" with groups devs` {
		t.Errorf("Describe = %q", got)
	}
}

func TestMiddlewareChallenge(t *testing.T) {
	f := newIssuer(t)
	a := &Authenticator{OIDC: f.verifier(OIDCOptions{}), Resource: resource, Issuer: issuer}
	var seen *Caller
	h := a.Middleware("https://mcp.example.com")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = CallerFrom(auth.TokenInfoFromContext(r.Context()))
	}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/mcp", nil))
	if rec.Code != http.StatusUnauthorized ||
		rec.Header().Get("WWW-Authenticate") != `Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"` {
		t.Errorf("unauthenticated = %d %q", rec.Code, rec.Header().Get("WWW-Authenticate"))
	}

	req := httptest.NewRequest("POST", "/mcp", nil)
	req.Header.Set("Authorization", "Bearer "+f.sign(t, nil))
	h.ServeHTTP(httptest.NewRecorder(), req)
	if seen == nil || seen.Sub != "alice-id" {
		t.Errorf("handler saw caller %+v", seen)
	}
}
