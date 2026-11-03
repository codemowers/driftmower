package oidctest

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
)

// Provider is a fake OIDC provider that signs in one fixed user without
// asking: discovery, an authorize endpoint that redirects straight back with
// a code, and a token endpoint enforcing PKCE and the resource indicator.
type Provider struct {
	*Issuer
	Server *httptest.Server
	// The user every sign-in yields.
	Subject string
	Claims  map[string]any

	mu    sync.Mutex
	codes map[string]grant
}

type grant struct {
	challenge, redirect, resource, nonce, clientID string
}

func NewProvider(t testing.TB, subject string) *Provider {
	t.Helper()
	p := &Provider{Subject: subject, codes: map[string]grant{}}
	mux := http.NewServeMux()
	p.Server = httptest.NewServer(mux)
	t.Cleanup(p.Server.Close)
	p.Issuer = New(t, p.Server.URL)

	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer":                                p.ID,
			"authorization_endpoint":                p.ID + "/authorize",
			"token_endpoint":                        p.ID + "/token",
			"jwks_uri":                              p.JWKSURL,
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/authorize", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("response_type") != "code" || q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" {
			http.Error(w, "PKCE S256 authorization code flow required", http.StatusBadRequest)

			return
		}
		code := randomCode()
		p.mu.Lock()
		p.codes[code] = grant{challenge: q.Get("code_challenge"), redirect: q.Get("redirect_uri"), resource: q.Get("resource"),
			nonce: q.Get("nonce"), clientID: q.Get("client_id")}
		p.mu.Unlock()
		back, _ := url.Parse(q.Get("redirect_uri"))
		v := back.Query()
		v.Set("code", code)
		v.Set("state", q.Get("state"))
		back.RawQuery = v.Encode()
		http.Redirect(w, r, back.String(), http.StatusFound)
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		p.mu.Lock()
		g, ok := p.codes[r.PostForm.Get("code")]
		delete(p.codes, r.PostForm.Get("code"))
		p.mu.Unlock()
		sum := sha256.Sum256([]byte(r.PostForm.Get("code_verifier")))
		switch {
		case !ok:
			http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
		case base64.RawURLEncoding.EncodeToString(sum[:]) != g.challenge:
			http.Error(w, `{"error":"invalid_grant","error_description":"PKCE verification failed"}`, http.StatusBadRequest)
		case r.PostForm.Get("redirect_uri") != g.redirect || r.PostForm.Get("resource") != g.resource:
			http.Error(w, `{"error":"invalid_grant","error_description":"redirect or resource mismatch"}`, http.StatusBadRequest)
		default:
			access := map[string]any{"azp": g.clientID}
			for k, v := range p.Claims {
				access[k] = v
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": p.Token(t, p.Subject, g.resource, access),
				"id_token":     p.Token(t, p.Subject, g.clientID, map[string]any{"nonce": g.nonce}),
				"token_type":   "Bearer",
				"expires_in":   3600,
			})
		}
	})

	return p
}

func randomCode() string { return rand.Text() }
