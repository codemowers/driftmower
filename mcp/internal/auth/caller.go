// Package auth verifies bearer tokens on the HTTP transport and maps verified
// callers to Kubernetes subjects.
package auth

import (
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"

	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/tenancy"
)

// Caller is a verified caller. It travels in the request context inside the
// SDK's TokenInfo, never in shared state, because the server and its services
// are shared by concurrent requests.
type Caller struct {
	Sub      string
	ClientID string
	Email    string
	Name     string
	// The `groups` claim, which this server audits and scopes by.
	Groups []string
	// Namespaces from the tenancy claim. A token without the claim differs
	// from one whose claim is empty.
	Namespaces tenancy.Claim
	// The claims kube-apiserver maps to a username and groups, read under the
	// configured claim names.
	IdentityClaims IdentityClaims
	// Set only for a ServiceAccount verified by TokenReview, whose Kubernetes
	// identity is used verbatim.
	Kubernetes *authz.Identity
}

type IdentityClaims struct {
	Username      string
	Groups        []string
	EmailVerified *bool
}

const callerKey = "driftmower.caller"

// NewTokenInfo wraps a caller for the SDK. UserID binds MCP sessions to the
// subject, so another caller cannot reuse a session ID.
func NewTokenInfo(c *Caller, scopes []string, exp time.Time) *auth.TokenInfo {
	return &auth.TokenInfo{
		Scopes:     scopes,
		Expiration: exp,
		UserID:     c.Sub,
		Extra:      map[string]any{callerKey: c},
	}
}

// CallerFrom returns the verified caller, or nil when the request was not
// authenticated (stdio, or HTTP with authentication off).
func CallerFrom(ti *auth.TokenInfo) *Caller {
	if ti == nil {
		return nil
	}
	c, _ := ti.Extra[callerKey].(*Caller)

	return c
}

// Subject names the caller for audit lines.
func Subject(c *Caller) string {
	if c == nil {
		return "anonymous"
	}

	return c.Sub
}
