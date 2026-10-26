// Package oidctest provides a fake OIDC issuer that publishes a key set and
// signs access tokens, for tests.
package oidctest

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

// Issuer is a fake OIDC issuer. Its ID is the issuer URL tokens carry; its
// key set is served at JWKSURL.
type Issuer struct {
	ID      string
	JWKSURL string
	key     *rsa.PrivateKey
}

func New(t testing.TB, id string) *Issuer {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{
			{Key: &key.PublicKey, KeyID: "test", Use: "sig"},
		}})
	}))
	t.Cleanup(srv.Close)

	return &Issuer{ID: id, JWKSURL: srv.URL, key: key}
}

// Token signs an access token for sub and audience, valid for an hour. Extra
// claims are added or, when nil, removed.
func (i *Issuer) Token(t testing.TB, sub, audience string, extra map[string]any) string {
	t.Helper()
	claims := map[string]any{
		"iss": i.ID,
		"aud": audience,
		"sub": sub,
		"exp": time.Now().Add(time.Hour).Unix(),
		"iat": time.Now().Unix(),
	}
	for k, v := range extra {
		if v == nil {
			delete(claims, k)
		} else {
			claims[k] = v
		}
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: i.key},
		(&jose.SignerOptions{}).WithHeader("kid", "test"))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := jwt.Signed(signer).Claims(claims).Serialize()
	if err != nil {
		t.Fatal(err)
	}

	return raw
}

// BearerClient returns an HTTP client that sends token on every request.
func BearerClient(token string) *http.Client {
	return &http.Client{Transport: bearer{token: token}}
}

type bearer struct{ token string }

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)

	return http.DefaultTransport.RoundTrip(r)
}
