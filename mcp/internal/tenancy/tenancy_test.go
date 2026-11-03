package tenancy

import (
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/codemowers/driftmower/mcp/internal/authz"
)

func rbac(namespaces ...string) authz.RBACScope {
	return authz.RBACScope{Namespaces: namespaces, Unknown: []string{}}
}

func claim(namespaces ...string) Claim {
	return Claim{Namespaces: namespaces, Present: true}
}

var noClaim = Claim{}

func assertScope(t *testing.T, got Scope, restricted bool, namespaces []string, source Source) {
	t.Helper()
	if got.Restricted != restricted || got.Source != source || (restricted && !slices.Equal(got.Namespaces, namespaces)) {
		t.Errorf("scope = %+v, want restricted=%v %v %s", got, restricted, namespaces, source)
	}
}

func TestClaimPolicyIgnoresAuthorizer(t *testing.T) {
	assertScope(t, Merge(claim("a"), rbac("b"), nil, PolicyClaim, ""), true, []string{"a"}, FromClaim)
	assertScope(t, Merge(noClaim, rbac("b"), nil, PolicyClaim, ""), true, []string{}, ClaimMissing)
}

func TestRBACPolicyIgnoresClaim(t *testing.T) {
	assertScope(t, Merge(claim("a"), rbac("b"), nil, PolicyRBAC, "user X"), true, []string{"b"}, FromRBAC)
	assertScope(t, Merge(claim("a"), rbac(), nil, PolicyRBAC, ""), true, []string{}, RBACEmpty)
}

func TestUnionTakesBothGrants(t *testing.T) {
	assertScope(t, Merge(claim("a"), rbac("b", "a"), nil, PolicyUnion, ""), true, []string{"a", "b"}, Union)
	assertScope(t, Merge(noClaim, rbac("b"), nil, PolicyUnion, ""), true, []string{"b"}, FromRBAC)
	assertScope(t, Merge(claim(), rbac(), nil, PolicyUnion, ""), true, []string{}, RBACEmpty)
}

func TestClusterWideLiftsRestriction(t *testing.T) {
	r := rbac()
	r.ClusterWide = true
	assertScope(t, Merge(claim("a"), r, nil, PolicyUnion, ""), false, nil, FromRBAC)
}

func TestUnanswerableAuthorizer(t *testing.T) {
	down := errors.New("webhook down")
	s := Merge(claim("a"), authz.RBACScope{}, down, PolicyUnion, "user X")
	assertScope(t, s, true, []string{"a"}, RBACInconclusive)
	if s.Detail.Identity != "user X" || s.Detail.RBACError != "webhook down" {
		t.Errorf("detail = %+v", s.Detail)
	}
	assertScope(t, Merge(claim("a"), authz.RBACScope{}, down, PolicyRBAC, ""), true, []string{}, RBACInconclusive)
}

func TestDescribe(t *testing.T) {
	down := errors.New("webhook down")

	if n := Describe(UnrestrictedScope, 3); n.Scoped || n.Namespaces != nil || n.Note != "" {
		t.Errorf("unrestricted = %+v", n)
	}

	// Under the rbac policy a claim is informational only, so it can name
	// namespaces the authorizer still denies.
	n := Describe(Merge(claim("a"), rbac(), nil, PolicyRBAC, `Kubernetes user "issuer#alice"`), 0)
	for _, want := range []string{"issuer#alice", "none of the namespaces your token claim names", "KUBERNETES_USERNAME_CLAIM"} {
		if !n.Scoped || !strings.Contains(n.Note, want) {
			t.Errorf("rbac-empty note %q lacks %q", n.Note, want)
		}
	}

	if got := Describe(Merge(claim("a"), authz.RBACScope{}, down, PolicyUnion, "user X"), 1).Note; got !=
		"Kubernetes could not evaluate your access as user X: webhook down. Results are limited to the 1 namespace(s) your token claim names: a. This is an authorizer problem, not an empty cluster." {
		t.Errorf("inconclusive note = %q", got)
	}
	if got := Describe(Merge(noClaim, authz.RBACScope{}, down, PolicyUnion, ""), 0).Note; !strings.Contains(got, "No results can be returned.") {
		t.Errorf("inconclusive without claim = %q", got)
	}

	r := rbac("a")
	r.Unknown = []string{"b"}
	r.Truncated = true
	n = Describe(Merge(noClaim, r, nil, PolicyUnion, ""), 2)
	for _, want := range []string{
		"Results are limited to the namespaces you may access: a.",
		"1 further namespace(s) could not be evaluated",
		"MCP_SCOPE_MAX_NAMESPACES",
	} {
		if !strings.Contains(n.Note, want) {
			t.Errorf("note %q lacks %q", n.Note, want)
		}
	}
	if !slices.Equal(n.Namespaces, []string{"a"}) {
		t.Errorf("namespaces = %v", n.Namespaces)
	}

	if got := Describe(Merge(noClaim, rbac("a"), nil, PolicyUnion, ""), 0).Note; !strings.HasPrefix(got, "No results within the namespaces you may access (a).") {
		t.Errorf("no-match note = %q", got)
	}
	if got := Describe(FromClaimOnly(noClaim), 0).Note; !strings.Contains(got, "carries no namespaces claim") {
		t.Errorf("claim-missing note = %q", got)
	}
	if n := Describe(FromClaimOnly(claim()), 0); n.Namespaces == nil || !strings.Contains(n.Note, "grants access to no namespaces") {
		t.Errorf("empty claim = %+v", n)
	}

	cw := rbac()
	cw.ClusterWide = true
	if n := Describe(Merge(noClaim, cw, nil, PolicyUnion, ""), 5); n.Scoped || n.Namespaces != nil {
		t.Errorf("cluster-wide = %+v", n)
	}

	if (Notice{Note: "x"}).Suffix() != " x" || (Notice{}).Suffix() != "" {
		t.Error("Suffix")
	}
}
