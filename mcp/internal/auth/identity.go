package auth

import (
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/codemowers/driftmower/mcp/internal/authz"
)

// Mapping reproduces kube-apiserver's OIDC mapping: --oidc-username-claim,
// --oidc-username-prefix, --oidc-groups-claim and --oidc-groups-prefix. Every
// review this server sends must reproduce it exactly, or the API server
// answers confidently about a user that does not exist.
type Mapping struct {
	// ReadAll is an explicitly configured read-only mode: verified OIDC
	// subjects need not map to Kubernetes usernames or groups.
	ReadAll        bool
	UsernameClaim  string
	GroupsClaim    string
	UsernamePrefix string
	GroupsPrefix   string
}

// Reasons a caller has no Kubernetes identity.
var (
	ErrUnauthenticated = errors.New("the call carries no verified caller identity")
	ErrEmailUnverified = errors.New("the access token marks its email claim unverified, which Kubernetes does not accept as a username")
)

// KubernetesIdentity is the one place a verified caller becomes a Kubernetes
// subject. Identity comes only from the verified transport context, never
// from tool arguments.
func KubernetesIdentity(c *Caller, m Mapping) (authz.Identity, error) {
	if c == nil || c.Sub == "" {
		return authz.Identity{}, ErrUnauthenticated
	}
	// Set only after an audience-bound TokenReview. ServiceAccounts already
	// carry Kubernetes names and must not gain OIDC prefixes.
	if c.Kubernetes != nil {
		return authz.Identity{User: c.Kubernetes.User, Groups: slices.Clone(c.Kubernetes.Groups)}, nil
	}
	if m.ReadAll {
		return authz.Identity{User: "oidc:" + c.Sub}, nil
	}

	username := c.IdentityClaims.Username
	if username == "" {
		return authz.Identity{}, fmt.Errorf("the access token carries no '%s' claim; "+
			"KUBERNETES_USERNAME_CLAIM must name a claim present in access tokens", m.UsernameClaim)
	}
	// kube-apiserver refuses an email username unless the token says it is
	// verified; answering for it here would be answering for nobody.
	if m.UsernameClaim == "email" && c.IdentityClaims.EmailVerified != nil && !*c.IdentityClaims.EmailVerified {
		return authz.Identity{}, ErrEmailUnverified
	}

	// The API server adds system:authenticated to every principal.
	groups := []string{"system:authenticated"}
	for _, g := range c.IdentityClaims.Groups {
		if g = m.GroupsPrefix + g; !slices.Contains(groups, g) {
			groups = append(groups, g)
		}
	}

	return authz.Identity{User: m.UsernamePrefix + username, Groups: groups}, nil
}

// Describe names an identity for prose, e.g.
// `Kubernetes user "issuer#alice" with groups devs`.
func Describe(id authz.Identity) string {
	var groups []string
	for _, g := range id.Groups {
		if g != "system:authenticated" {
			groups = append(groups, g)
		}
	}
	s := fmt.Sprintf("Kubernetes user %q", id.User)
	if len(groups) > 0 {
		s += " with groups " + strings.Join(groups, ", ")
	}

	return s
}
