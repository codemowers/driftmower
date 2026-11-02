// Package tenancy decides which namespaces a caller may see driftmower-be
// results for, from the token's namespaces claim and the cluster authorizer.
package tenancy

import (
	"fmt"
	"slices"
	"strings"

	"github.com/codemowers/driftmower/mcp/internal/authz"
)

// Source says why a scope is what it is. Each needs its own sentence: an
// unrestricted caller needs no note, a caller with an empty claim has a
// tenancy answer, a caller whose token carries no claim has a configuration
// problem with a specific fix, and a caller whose RBAC could not be evaluated
// has an authorizer problem that is nobody's tenancy answer.
type Source string

const (
	Unrestricted Source = "unrestricted"
	FromClaim    Source = "claim"
	ClaimMissing Source = "claim-missing"
	// Decided by the cluster authorizer.
	FromRBAC Source = "rbac"
	// The authorizer answered, and the answer was: nowhere.
	RBACEmpty Source = "rbac-empty"
	// The authorizer could not be asked, or could not answer.
	RBACInconclusive Source = "rbac-inconclusive"
	// Claim and RBAC both contributed.
	Union Source = "union"
)

// Policy selects which sources confine results.
type Policy string

const (
	PolicyClaim Policy = "claim"
	PolicyRBAC  Policy = "rbac"
	PolicyUnion Policy = "union"
)

// Claim is the token's namespaces claim. A token without the claim differs
// from one whose claim is empty.
type Claim struct {
	Namespaces []string
	Present    bool
}

// Scope is the resolved set of namespaces. When Restricted is false the
// caller sees everything; when it is true, only Namespaces, which may be
// empty. An empty restriction is never collapsed into "unrestricted": a caller
// entitled to no namespaces must see nothing, not everything.
type Scope struct {
	Restricted bool
	Namespaces []string
	Source     Source
	Detail     Detail
}

// Detail records what each source contributed, for the scope note.
type Detail struct {
	// The mapped Kubernetes identity the reviews were sent as, for prose.
	Identity    string
	Claim       Claim
	RBAC        []string
	ClusterWide bool
	Truncated   bool
	// Namespaces the authorizer could not evaluate.
	Unknown   int
	RBACError string
}

// UnrestrictedScope applies when the transport did not authenticate the call:
// stdio, or HTTP with authentication off.
var UnrestrictedScope = Scope{Source: Unrestricted}

// FromClaimOnly projects a token's namespaces claim onto a scope. A token
// without the claim resolves to the empty scope, not the unrestricted one:
// failing open would hand every caller the whole fleet when the OIDC client
// drops the `namespaces` scope, a plausible misconfiguration.
func FromClaimOnly(claim Claim) Scope {
	if !claim.Present {
		return Scope{Restricted: true, Namespaces: []string{}, Source: ClaimMissing}
	}

	return Scope{Restricted: true, Namespaces: slices.Clone(claim.Namespaces), Source: FromClaim}
}

// Merge combines the claim and the authorizer's answer under a policy. Pass a
// non-nil rbacErr when the authorizer could not be asked.
//
// Union is deliberately permissive in one direction only: an absent claim
// contributes nothing, and an unanswerable authorizer contributes nothing, so
// a caller ends up with the union of whatever each source could vouch for.
// Neither source can remove a namespace the other granted; both are grants,
// and the cluster still enforces every read.
func Merge(claim Claim, rbac authz.RBACScope, rbacErr error, policy Policy, identity string) Scope {
	if policy == PolicyClaim {
		return FromClaimOnly(claim)
	}

	detail := Detail{Identity: identity, Claim: claim}
	if rbacErr != nil {
		detail.RBACError = rbacErr.Error()
	} else {
		detail.RBAC = rbac.Namespaces
		detail.ClusterWide = rbac.ClusterWide
		detail.Truncated = rbac.Truncated
		detail.Unknown = len(rbac.Unknown)
	}

	if rbacErr == nil && rbac.ClusterWide {
		return Scope{Source: FromRBAC, Detail: detail}
	}

	var fromClaim, fromRBAC []string
	if policy == PolicyUnion {
		fromClaim = claim.Namespaces
	}
	if rbacErr == nil {
		fromRBAC = rbac.Namespaces
	}
	merged := slices.Concat(fromClaim, fromRBAC)
	slices.Sort(merged)
	merged = slices.Compact(merged)
	if merged == nil {
		merged = []string{}
	}

	scope := Scope{Restricted: true, Namespaces: merged, Detail: detail}
	switch {
	case rbacErr != nil:
		scope.Source = RBACInconclusive
	case len(merged) == 0:
		scope.Source = RBACEmpty
	case len(fromClaim) > 0 && len(fromRBAC) > 0:
		scope.Source = Union
	default:
		scope.Source = FromRBAC
	}

	return scope
}

// Notice is handed back with every scoped result. An agent that cannot tell
// "there is nothing behind this" from "you are not allowed to see it" will
// confidently report the wrong one, so the distinction is part of the payload.
type Notice struct {
	Scoped bool `json:"scoped"`
	// Null when unscoped.
	Namespaces []string `json:"namespaces"`
	Note       string   `json:"note,omitempty"`
}

// Suffix is the note as a sentence to append to a text summary, or "". A
// summary that drops it turns a withheld result into an apparently empty one.
func (n Notice) Suffix() string {
	if n.Note == "" {
		return ""
	}

	return " " + n.Note
}

// Describe explains a scope to the caller, given how many results matched.
func Describe(s Scope, matches int) Notice {
	if !s.Restricted {
		return Notice{}
	}
	namespaces := slices.Clone(s.Namespaces)
	if namespaces == nil {
		namespaces = []string{}
	}
	list := strings.Join(s.Namespaces, ", ")

	switch {
	case s.Source == ClaimMissing:
		return Notice{Scoped: true, Namespaces: []string{}, Note: "Your access token carries no namespaces claim, so no results can be returned. " +
			"Request the `namespaces` scope when obtaining the token; this is a token problem, not an empty cluster."}

	case s.Source == RBACInconclusive:
		fallback := " No results can be returned."
		if len(s.Namespaces) > 0 {
			fallback = fmt.Sprintf(" Results are limited to the %d namespace(s) your token claim names: %s.", len(s.Namespaces), list)
		}
		as := ""
		if s.Detail.Identity != "" {
			as = " as " + s.Detail.Identity
		}
		reason := s.Detail.RBACError
		if reason == "" {
			reason = "the access review failed"
		}

		return Notice{Scoped: true, Namespaces: namespaces, Note: "Kubernetes could not evaluate your access" + as + ": " +
			reason + "." + fallback + " This is an authorizer problem, not an empty cluster."}

	case s.Source == RBACEmpty:
		who := s.Detail.Identity
		if who == "" {
			who = "your identity"
		}
		claimed := ""
		if len(s.Detail.Claim.Namespaces) > 0 {
			claimed = ", and none of the namespaces your token claim names"
		}

		return Notice{Scoped: true, Namespaces: []string{}, Note: "Kubernetes RBAC grants " + who + " list-pods access in no namespace" +
			claimed + ", so no results can be returned. If that is unexpected, check KUBERNETES_USERNAME_CLAIM and " +
			"KUBERNETES_USERNAME_PREFIX against the apiserver OIDC mapping. This is an authorization limit, not an empty cluster."}

	case len(s.Namespaces) == 0:
		return Notice{Scoped: true, Namespaces: []string{}, Note: "Your access token grants access to no namespaces, so no results can be returned. " +
			"This is an authorization limit, not an empty cluster."}
	}

	var note string
	if matches == 0 {
		note = "No results within the namespaces you may access (" + list + "). " +
			"Matching workloads may exist in namespaces outside your access."
	} else {
		note = "Results are limited to the namespaces you may access: " + list + "."
	}
	if s.Detail.Unknown > 0 {
		note += fmt.Sprintf(" Access to %d further namespace(s) could not be evaluated by the cluster authorizer; they are excluded, not denied.", s.Detail.Unknown)
	}
	if s.Detail.Truncated {
		note += " The cluster has more namespaces than the access sweep checks; raise MCP_SCOPE_MAX_NAMESPACES if results seem incomplete."
	}

	return Notice{Scoped: true, Namespaces: namespaces, Note: note}
}
