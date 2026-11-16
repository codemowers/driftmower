package useraccess

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	authorizationv1 "k8s.io/api/authorization/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"

	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
)

type judgeFunc func(authz.Identity, authz.Attributes) authz.Verdict

func (f judgeFunc) MayPerform(_ context.Context, id authz.Identity, a authz.Attributes) authz.Judgement {
	return authz.Judgement{Verdict: f(id, a)}
}

const issuer = "https://auth.example/#"

var mapping = auth.Mapping{UsernameClaim: "sub", GroupsClaim: "groups", UsernamePrefix: issuer}

func oidcUser(name string, groups ...map[string]any) *unstructured.Unstructured {
	gs := make([]any, len(groups))
	for i, g := range groups {
		gs[i] = g
	}

	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "codemowers.cloud/v1", "kind": "OIDCUser",
		"metadata": map[string]any{"name": name, "namespace": "passmower"},
		"spec":     map[string]any{"type": "person"},
		"status": map[string]any{
			"primaryEmail": name + "@example.com", "emails": []any{name + "@example.com"},
			"profile": map[string]any{"name": strings.ToUpper(name)}, "groups": gs, "passkeyCount": int64(1),
			"recentApplications": []any{
				map[string]any{"clientNamespace": "a", "clientName": "old", "lastAuthenticatedAt": "2026-01-01T00:00:00Z"},
				map[string]any{"clientNamespace": "b", "clientName": "new", "lastAuthenticatedAt": "2026-02-01T00:00:00.5Z"},
			},
		},
	}}
}

func rule(groups, resources, verbs []string, names ...string) authorizationv1.ResourceRule {
	return authorizationv1.ResourceRule{APIGroups: groups, Resources: resources, Verbs: verbs, ResourceNames: names}
}

// cluster is a fake authorizer: baseline rules everywhere, extra rules per
// namespace, and the namespaces where pods are visible.
type cluster struct {
	mu       sync.Mutex
	reviews  []string
	baseline []authorizationv1.ResourceRule
	extra    map[string][]authorizationv1.ResourceRule
	pods     map[string]bool
	admins   map[string]bool
}

func (c *cluster) rules(_ context.Context, id authz.Identity, ns string) (authorizationv1.SubjectRulesReviewStatus, error) {
	c.mu.Lock()
	c.reviews = append(c.reviews, ns)
	c.mu.Unlock()
	if ns == "broken" {
		return authorizationv1.SubjectRulesReviewStatus{}, errors.New("boom")
	}

	return authorizationv1.SubjectRulesReviewStatus{
		ResourceRules:    append(append([]authorizationv1.ResourceRule{}, c.baseline...), c.extra[ns]...),
		NonResourceRules: []authorizationv1.NonResourceRule{{Verbs: []string{"get"}, NonResourceURLs: []string{"/healthz", "/version"}}},
		Incomplete:       ns == "webhooked",
	}, nil
}

func (c *cluster) judge(id authz.Identity, a authz.Attributes) authz.Verdict {
	if c.admins[id.User] {
		return authz.Yes
	}
	if a.Resource == "pods" && a.Verb == "list" && c.pods[a.Namespace] {
		return authz.Yes
	}

	return authz.No
}

func newService(t *testing.T, c *cluster, namespaces []string, users ...runtime.Object) *Service {
	t.Helper()
	scheme := runtime.NewScheme()
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, map[schema.GroupVersionResource]string{OIDCUsersGVR: "OIDCUserList", serviceAccountsGVR: "ServiceAccountList", roleBindingsGVR: "RoleBindingList", clusterRoleBindingsGVR: "ClusterRoleBindingList"}, users...)
	j := judgeFunc(c.judge)
	list := func(context.Context) ([]string, error) { return namespaces, nil }

	return &Service{
		Dynamic: dyn, Judge: j, Mapping: mapping, Namespace: "passmower", Rules: c.rules, CacheTTL: time.Minute,
		ListNamespaces: list, Scope: &authz.ScopeResolver{ListNamespaces: list, Judge: j},
	}
}

var admin = authz.Identity{User: issuer + "root", Groups: []string{"system:authenticated"}}

func TestIdentityReproducesAPIServerMapping(t *testing.T) {
	u := userFrom(oidcUser("alice", map[string]any{"prefix": "github.com", "name": "org:devs"}, map[string]any{"name": "plain"}))
	id, err := Identity(u, auth.Mapping{UsernameClaim: "sub", UsernamePrefix: issuer, GroupsPrefix: "oidc:"})
	if err != nil {
		t.Fatal(err)
	}
	want := authz.Identity{User: issuer + "alice", Groups: []string{"system:authenticated", "oidc:github.com:org:devs", "oidc:plain"}}
	if !reflect.DeepEqual(id, want) {
		t.Fatalf("identity = %+v, want %+v", id, want)
	}
	if id, _ := Identity(u, auth.Mapping{UsernameClaim: "email"}); id.User != "alice@example.com" {
		t.Fatalf("email identity = %q", id.User)
	}
	if _, err := Identity(u, auth.Mapping{UsernameClaim: "preferred_username"}); !errors.Is(err, ErrUnmappable) {
		t.Fatalf("unknown claim: %v", err)
	}
	if u.LastApplication != "b/new" || u.DisplayName != "ALICE" || u.PasskeyCount != 1 {
		t.Fatalf("summary = %+v", u)
	}
}

func TestInspectCollapsesBaselineAndMergesNamespaces(t *testing.T) {
	c := &cluster{
		baseline: []authorizationv1.ResourceRule{
			rule([]string{"authorization.k8s.io"}, []string{"selfsubjectrulesreviews"}, []string{"create"}),
			rule([]string{""}, []string{"namespaces"}, []string{"get", "list"}),
		},
		extra: map[string][]authorizationv1.ResourceRule{
			"a": {rule([]string{""}, []string{"pods", "secrets"}, []string{"get", "list"}), rule([]string{""}, []string{"namespaces"}, []string{"get"})},
			"b": {rule([]string{""}, []string{"pods"}, []string{"list", "get"}), rule([]string{""}, []string{"configmaps"}, []string{"get"}, "cfg")},
			// Rights without pod visibility are invisible to the probe.
			"hidden": {rule([]string{""}, []string{"secrets"}, []string{"*"})},
		},
		pods:   map[string]bool{"a": true, "b": true, "webhooked": true},
		admins: map[string]bool{admin.User: true},
	}
	s := newService(t, c, []string{"a", "b", "hidden", "webhooked"}, oidcUser("alice"))

	a, err := s.Inspect(context.Background(), admin, "alice", false)
	if err != nil {
		t.Fatal(err)
	}
	if a.ClusterAdmin || a.TotalNamespaces != 4 || !reflect.DeepEqual(a.Examined, []string{"a", "b", "webhooked"}) {
		t.Fatalf("access = %+v", a)
	}
	if len(a.ClusterWide) != 2 || a.ClusterWide[0].Resource != "namespaces" {
		t.Fatalf("cluster-wide = %+v", a.ClusterWide)
	}
	want := []Grant{
		{Group: "", Resource: "configmaps", ResourceNames: []string{"cfg"}, Verbs: []string{"get"}, Namespaces: []string{"b"}},
		{Group: "", Resource: "pods", Verbs: []string{"get", "list"}, Namespaces: []string{"a", "b"}},
		{Group: "", Resource: "secrets", Verbs: []string{"get", "list"}, Namespaces: []string{"a"}},
	}
	if !reflect.DeepEqual(a.Namespaced, want) {
		t.Fatalf("namespaced = %+v\nwant %+v", a.Namespaced, want)
	}
	if !reflect.DeepEqual(a.Incomplete, []string{"webhooked"}) {
		t.Fatalf("incomplete = %v", a.Incomplete)
	}
	if c.reviews[0] != probeBase {
		t.Fatalf("first review in %q, want the baseline probe", c.reviews[0])
	}

	// Cached: no further reviews until refresh.
	before := len(c.reviews)
	if _, err := s.Inspect(context.Background(), admin, "alice", false); err != nil || len(c.reviews) != before {
		t.Fatalf("cache missed: %v, %d reviews", err, len(c.reviews)-before)
	}
	if _, err := s.Inspect(context.Background(), admin, "alice", true); err != nil || len(c.reviews) == before {
		t.Fatalf("refresh did not re-evaluate: %v", err)
	}
}

func TestInspectCollapsesClusterAdmin(t *testing.T) {
	c := &cluster{
		baseline: []authorizationv1.ResourceRule{rule([]string{"*"}, []string{"*"}, []string{"*"})},
		admins:   map[string]bool{admin.User: true},
	}
	s := newService(t, c, []string{"a", "b"}, oidcUser("root"))
	a, err := s.Inspect(context.Background(), admin, "root", false)
	if err != nil {
		t.Fatal(err)
	}
	if !a.ClusterAdmin || len(a.Namespaced) != 0 || len(c.reviews) != 1 {
		t.Fatalf("access = %+v after %d reviews", a, len(c.reviews))
	}
}

func TestInspectRequiresImpersonation(t *testing.T) {
	c := &cluster{}
	s := newService(t, c, nil, oidcUser("alice"))
	reader := authz.Identity{User: issuer + "reader"}
	s.Judge = judgeFunc(func(id authz.Identity, a authz.Attributes) authz.Verdict {
		if a.Resource == "oidcusers" {
			return authz.Yes
		}

		return authz.No
	})
	if _, err := s.ListUsers(context.Background(), reader); err != nil {
		t.Fatalf("list: %v", err)
	}
	if _, err := s.Inspect(context.Background(), reader, "alice", false); !errors.Is(err, ErrForbidden) {
		t.Fatalf("inspect without impersonation: %v", err)
	}
	if len(c.reviews) != 0 {
		t.Fatal("rules were reviewed for an unauthorized caller")
	}
}

func TestSubtractHonoursWildcards(t *testing.T) {
	baseline := atoms([]authorizationv1.ResourceRule{
		rule([]string{"apps"}, []string{"*"}, []string{"get"}),
		rule([]string{""}, []string{"pods/*"}, []string{"*"}),
	})
	in := atoms([]authorizationv1.ResourceRule{
		rule([]string{"apps"}, []string{"deployments"}, []string{"get", "patch"}),
		rule([]string{""}, []string{"pods/log", "pods"}, []string{"get"}),
	})
	got := subtract(in, baseline)
	want := []atom{{"apps", "deployments", "", "patch"}, {"", "pods", "", "get"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("subtract = %+v", got)
	}
}

func TestProbeNamespaceAvoidsExisting(t *testing.T) {
	if got := probeNamespace([]string{probeBase}); got == probeBase || !strings.HasPrefix(got, probeBase+"-") {
		t.Fatalf("probe = %q", got)
	}
}

func TestSelfNeedsNoPermissionAndUsesTheTokenIdentity(t *testing.T) {
	c := &cluster{baseline: []authorizationv1.ResourceRule{rule([]string{""}, []string{"pods"}, []string{"get", "list"})}, pods: map[string]bool{"team": true}}
	s := newService(t, c, []string{"team"})
	var reviewed []authz.Identity
	s.Rules = func(ctx context.Context, id authz.Identity, ns string) (authorizationv1.SubjectRulesReviewStatus, error) {
		reviewed = append(reviewed, id)

		return c.rules(ctx, id, ns)
	}
	me := authz.Identity{User: issuer + "me", Groups: []string{"oidc:team", "system:authenticated"}}
	a, err := s.Self(context.Background(), me, false)
	if err != nil {
		t.Fatal(err)
	}
	if a.User.Name != me.User || !slices.Equal(a.Identity.Groups, me.Groups) || len(a.ClusterWide) != 1 {
		t.Fatalf("access = %+v", a)
	}
	for _, id := range reviewed {
		if id.Key() != me.Key() {
			t.Fatalf("reviewed as %+v, want the caller", id)
		}
	}
}
