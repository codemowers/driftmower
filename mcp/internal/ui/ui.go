// Package ui serves the browser explorer at /ui: server-rendered pages over
// the same services the MCP tools use, signed in with OIDC and acting as the
// signed-in caller.
package ui

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"errors"
	"html/template"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"

	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/catalog"
	"github.com/codemowers/driftmower/mcp/internal/cluster"
	"github.com/codemowers/driftmower/mcp/internal/observability"
	"github.com/codemowers/driftmower/mcp/internal/provisioning/service"
	"github.com/codemowers/driftmower/mcp/internal/workloads"
)

// UI is the explorer. Nil services hide their pages.
type UI struct {
	PublicURL string
	Issuer    string
	// The public OIDC client the explorer signs in with, using PKCE.
	ClientID string
	// Verifies an access token minted for this server's /mcp resource, the
	// same check every MCP request gets.
	Verify  func(ctx context.Context, raw string) (*auth.Caller, error)
	Mapping auth.Mapping
	Cluster cluster.Identity

	Scope         *authz.ScopeResolver
	Workloads     *workloads.Cache
	Actions       *workloads.Actions
	Catalog       *catalog.Catalog
	Provisioning  *service.Service
	Observability *observability.Service
	Logger        *slog.Logger
	// Used for the provider's discovery and token endpoints; defaults to a
	// client with a 10 s timeout.
	HTTPClient *http.Client

	once     sync.Mutex
	provider *oidc.Provider

	mu       sync.Mutex
	pending  map[string]pendingLogin
	sessions map[string]*session
}

type pendingLogin struct {
	verifier, nonce string
	expires         time.Time
}

type session struct {
	caller  *auth.Caller
	csrf    string
	expires time.Time
}

const (
	sessionCookie = "dm_session"
	loginCookie   = "dm_login"
	loginTTL      = 10 * time.Minute
)

//go:embed templates/*.html
var templateFS embed.FS

var templates = template.Must(template.New("").Funcs(funcs).ParseFS(templateFS, "templates/*.html"))

func (u *UI) resource() string { return u.PublicURL + "/mcp" }

func (u *UI) httpClient() *http.Client {
	if u.HTTPClient != nil {
		return u.HTTPClient
	}

	return &http.Client{Timeout: 10 * time.Second}
}

// oauth discovers the provider on first use, retrying after a failure.
func (u *UI) oauth(ctx context.Context) (*oidc.Provider, *oauth2.Config, error) {
	u.once.Lock()
	defer u.once.Unlock()
	if u.provider == nil {
		p, err := oidc.NewProvider(oidc.ClientContext(ctx, u.httpClient()), u.Issuer)
		if err != nil {
			return nil, nil, err
		}
		u.provider = p
	}

	return u.provider, &oauth2.Config{
		ClientID:    u.ClientID,
		Endpoint:    u.provider.Endpoint(),
		RedirectURL: u.PublicURL + "/ui/callback",
		Scopes:      []string{oidc.ScopeOpenID, "profile", "email", "groups", "namespaces"},
	}, nil
}

func (u *UI) secure() bool { return strings.HasPrefix(u.PublicURL, "https://") }

func (u *UI) setCookie(w http.ResponseWriter, name, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: "/ui", MaxAge: maxAge, HttpOnly: true, Secure: u.secure(), SameSite: http.SameSiteLaxMode})
}

// Handler serves /ui and everything under it.
func (u *UI) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ui/login", u.login)
	mux.HandleFunc("GET /ui/callback", u.callback)
	mux.HandleFunc("POST /ui/logout", u.logout)
	mux.HandleFunc("GET /ui", u.page(u.namespaces))
	mux.HandleFunc("GET /ui/{$}", u.page(u.namespaces))
	mux.HandleFunc("GET /ui/namespaces/{namespace}", u.page(u.namespace))
	mux.HandleFunc("GET /ui/namespaces/{namespace}/readiness", u.page(u.readiness))
	mux.HandleFunc("GET /ui/namespaces/{namespace}/pods/{pod}", u.page(u.podUsage))
	mux.HandleFunc("POST /ui/namespaces/{namespace}/restart", u.action(u.restart))
	mux.HandleFunc("POST /ui/namespaces/{namespace}/terminate", u.action(u.terminate))
	mux.HandleFunc("GET /ui/usage", u.page(u.clusterUsage))
	mux.HandleFunc("GET /ui/catalog", u.page(u.catalog))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Cache-Control", "no-store")
		if _, pattern := mux.Handler(r); pattern == "" {
			u.render(w, http.StatusNotFound, "error", view{Title: "Not found", Error: "There is no such page."})

			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (u *UI) login(w http.ResponseWriter, r *http.Request) {
	_, cfg, err := u.oauth(r.Context())
	if err != nil {
		u.Logger.Warn("OIDC discovery failed", "error", err)
		u.render(w, http.StatusBadGateway, "error", view{Title: "Sign-in unavailable", Error: "The identity provider could not be reached; try again shortly."})

		return
	}
	state, verifier, nonce := rand.Text(), oauth2.GenerateVerifier(), rand.Text()
	u.mu.Lock()
	if u.pending == nil {
		u.pending = map[string]pendingLogin{}
	}
	now := time.Now()
	for k, p := range u.pending {
		if now.After(p.expires) {
			delete(u.pending, k)
		}
	}
	u.pending[state] = pendingLogin{verifier: verifier, nonce: nonce, expires: now.Add(loginTTL)}
	u.mu.Unlock()
	// The cookie binds the callback to this browser, so a forged callback
	// cannot sign someone in as the attacker.
	u.setCookie(w, loginCookie, state, int(loginTTL.Seconds()))
	http.Redirect(w, r, cfg.AuthCodeURL(state, oauth2.S256ChallengeOption(verifier), oidc.Nonce(nonce),
		oauth2.SetAuthURLParam("resource", u.resource())), http.StatusFound)
}

func (u *UI) callback(w http.ResponseWriter, r *http.Request) {
	fail := func(status int, message string, err error) {
		if err != nil {
			u.Logger.Warn("explorer sign-in failed", "error", err)
		}
		u.render(w, status, "error", view{Title: "Sign-in failed", Error: message})
	}
	state := r.URL.Query().Get("state")
	cookie, err := r.Cookie(loginCookie)
	if err != nil || state == "" || subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(state)) != 1 {
		fail(http.StatusBadRequest, "The sign-in did not start in this browser; start again.", nil)

		return
	}
	u.setCookie(w, loginCookie, "", -1)
	u.mu.Lock()
	pending, ok := u.pending[state]
	delete(u.pending, state)
	u.mu.Unlock()
	if !ok || time.Now().After(pending.expires) {
		fail(http.StatusBadRequest, "The sign-in expired; start again.", nil)

		return
	}
	if e := r.URL.Query().Get("error"); e != "" {
		fail(http.StatusUnauthorized, "The identity provider refused the sign-in: "+e, nil)

		return
	}

	provider, cfg, err := u.oauth(r.Context())
	if err != nil {
		fail(http.StatusBadGateway, "The identity provider could not be reached.", err)

		return
	}
	ctx := oidc.ClientContext(r.Context(), u.httpClient())
	token, err := cfg.Exchange(ctx, r.URL.Query().Get("code"), oauth2.VerifierOption(pending.verifier),
		oauth2.SetAuthURLParam("resource", u.resource()))
	if err != nil {
		fail(http.StatusUnauthorized, "The authorization code could not be exchanged.", err)

		return
	}
	if raw, ok := token.Extra("id_token").(string); ok {
		id, err := provider.Verifier(&oidc.Config{ClientID: u.ClientID}).Verify(ctx, raw)
		if err != nil || id.Nonce != pending.nonce {
			fail(http.StatusUnauthorized, "The identity token did not match this sign-in.", err)

			return
		}
	}
	caller, err := u.Verify(r.Context(), token.AccessToken)
	if err != nil {
		fail(http.StatusUnauthorized, "The access token was not accepted for this server.", err)

		return
	}

	expires := token.Expiry
	if expires.IsZero() {
		expires = time.Now().Add(time.Hour)
	}
	id := rand.Text()
	u.mu.Lock()
	if u.sessions == nil {
		u.sessions = map[string]*session{}
	}
	for k, s := range u.sessions {
		if time.Now().After(s.expires) {
			delete(u.sessions, k)
		}
	}
	u.sessions[id] = &session{caller: caller, csrf: rand.Text(), expires: expires}
	u.mu.Unlock()
	u.setCookie(w, sessionCookie, id, int(time.Until(expires).Seconds()))
	http.Redirect(w, r, "/ui", http.StatusFound)
}

func (u *UI) logout(w http.ResponseWriter, r *http.Request) {
	if s, id := u.session(r); s != nil && u.csrfOK(r, s) {
		u.mu.Lock()
		delete(u.sessions, id)
		u.mu.Unlock()
	}
	u.setCookie(w, sessionCookie, "", -1)
	http.Redirect(w, r, "/ui", http.StatusSeeOther)
}

// session returns the live session for the request, if any.
func (u *UI) session(r *http.Request) (*session, string) {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return nil, ""
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	s := u.sessions[c.Value]
	if s == nil || time.Now().After(s.expires) {
		delete(u.sessions, c.Value)

		return nil, ""
	}

	return s, c.Value
}

func (u *UI) csrfOK(r *http.Request, s *session) bool {
	return subtle.ConstantTimeCompare([]byte(r.PostFormValue("csrf")), []byte(s.csrf)) == 1
}

// request is one signed-in page view.
type request struct {
	*http.Request
	session  *session
	identity authz.Identity
}

var errNoIdentity = errors.New("your sign-in carries no identity Kubernetes accepts")

// page requires a session; without one it offers sign-in.
func (u *UI) page(fn func(request) (string, view, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s, _ := u.session(r)
		if s == nil {
			u.render(w, http.StatusOK, "signin", view{Title: "Sign in"})

			return
		}
		id, err := auth.KubernetesIdentity(s.caller, u.Mapping)
		if err != nil {
			u.render(w, http.StatusForbidden, "error", u.base(s, view{Title: "Not authorized", Error: errNoIdentity.Error() + ": " + err.Error()}))

			return
		}
		name, v, err := fn(request{Request: r, session: s, identity: id})
		if err != nil {
			v.Error = err.Error()
			if name == "" {
				name = "error"
			}
		}
		u.render(w, http.StatusOK, name, u.base(s, v))
	}
}

// action runs a CSRF-checked POST and redirects back with its outcome.
func (u *UI) action(fn func(request) (string, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s, _ := u.session(r)
		if s == nil || !u.csrfOK(r, s) {
			u.render(w, http.StatusForbidden, "error", view{Title: "Not allowed", Error: "The form expired or did not come from this page; reload and try again."})

			return
		}
		id, err := auth.KubernetesIdentity(s.caller, u.Mapping)
		if err != nil {
			u.render(w, http.StatusForbidden, "error", u.base(s, view{Title: "Not authorized", Error: err.Error()}))

			return
		}
		message, err := fn(request{Request: r, session: s, identity: id})
		if err != nil {
			message = "Refused: " + err.Error()
		}
		back := "/ui/namespaces/" + url.PathEscape(r.PathValue("namespace")) + "?message=" + url.QueryEscape(message)
		http.Redirect(w, r, back, http.StatusSeeOther)
	}
}

// view is what every template receives.
type view struct {
	Title   string
	Error   string
	Message string
	User    string
	CSRF    string
	Cluster string
	Nav     nav
	Data    any
}

type nav struct {
	Usage   bool
	Catalog bool
}

func (u *UI) base(s *session, v view) view {
	v.User, v.CSRF = s.caller.Sub, s.csrf
	if u.Cluster.ID != nil {
		v.Cluster = *u.Cluster.ID
	}
	v.Nav = nav{Usage: u.Observability != nil && u.Observability.MetricsEnabled(), Catalog: u.Catalog != nil}

	return v
}

func (u *UI) render(w http.ResponseWriter, status int, name string, v view) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	if err := templates.ExecuteTemplate(w, name, v); err != nil {
		u.Logger.Error("render explorer page", "page", name, "error", err)
	}
}
