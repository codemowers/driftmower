package useraccess

import (
	"context"
	"errors"
	"reflect"
	"testing"

	authorizationv1 "k8s.io/api/authorization/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
)

func serviceAccount(namespace, name, createdBy string) *unstructured.Unstructured {
	meta := map[string]any{"name": name, "namespace": namespace, "creationTimestamp": "2026-01-01T00:00:00Z"}
	if createdBy != "" {
		meta["annotations"] = map[string]any{"codemowers.io/created-by": createdBy}
	}

	return &unstructured.Unstructured{Object: map[string]any{"apiVersion": "v1", "kind": "ServiceAccount", "metadata": meta}}
}

func TestSubjectOfUndoesTheUsernameMapping(t *testing.T) {
	for _, tc := range []struct {
		username string
		mapping  auth.Mapping
		want     Subject
	}{
		{issuer + "alice", mapping, Subject{Username: issuer + "alice", OIDCUser: "alice"}},
		{"system:serviceaccount:apps:deployer", mapping, Subject{Username: "system:serviceaccount:apps:deployer", ServiceAccount: &ServiceAccountRef{Namespace: "apps", Name: "deployer"}}},
		{"system:admin", mapping, Subject{Username: "system:admin"}},
		{"https://other.example/#alice", mapping, Subject{Username: "https://other.example/#alice"}},
		// Email usernames are not OIDCUser names.
		{"alice@example.com", auth.Mapping{UsernameClaim: "email"}, Subject{Username: "alice@example.com"}},
	} {
		if got := SubjectOf(tc.username, tc.mapping); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("SubjectOf(%q) = %+v, want %+v", tc.username, got, tc.want)
		}
	}
}

func TestServiceAccountsListAndInspectAsTheirTokens(t *testing.T) {
	c := &cluster{baseline: []authorizationv1.ResourceRule{rule([]string{""}, []string{"configmaps"}, []string{"get"})}, admins: map[string]bool{admin.User: true}}
	var reviewed authz.Identity
	rules := c.rules
	binding := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "RoleBinding",
		"metadata": map[string]any{"name": "deploy", "namespace": "apps"},
		"subjects": []any{map[string]any{"kind": "ServiceAccount", "name": "deployer"}, map[string]any{"kind": "Group", "name": "system:serviceaccounts"}}}}
	s := newService(t, c, []string{"apps"}, serviceAccount("apps", "deployer", issuer+"alice"), serviceAccount("apps", "default", ""), binding)
	s.Rules = func(ctx context.Context, id authz.Identity, ns string) (authorizationv1.SubjectRulesReviewStatus, error) {
		reviewed = id
		return rules(ctx, id, ns)
	}

	sas, err := s.ListServiceAccounts(context.Background(), admin)
	if err != nil {
		t.Fatal(err)
	}
	if len(sas) != 2 || sas[0].Name != "default" || sas[0].CreatedBy != nil || sas[0].Bound || sas[1].CreatedBy == nil || sas[1].CreatedBy.OIDCUser != "alice" || !sas[1].Bound {
		t.Fatalf("service accounts = %+v", sas)
	}

	a, err := s.InspectServiceAccount(context.Background(), admin, "apps", "deployer", false)
	if err != nil {
		t.Fatal(err)
	}
	want := authz.Identity{User: "system:serviceaccount:apps:deployer", Groups: []string{"system:serviceaccounts", "system:serviceaccounts:apps", "system:authenticated"}}
	if !reflect.DeepEqual(reviewed, want) || a.User.Type != "ServiceAccount" || len(a.Warnings) != 0 {
		t.Fatalf("reviewed as %+v, access %+v", reviewed, a)
	}

	stranger := authz.Identity{User: issuer + "bob"}
	if _, err := s.ListServiceAccounts(context.Background(), stranger); !errors.Is(err, ErrForbidden) {
		t.Fatalf("list as stranger: %v", err)
	}
	if _, err := s.InspectServiceAccount(context.Background(), stranger, "apps", "deployer", false); !errors.Is(err, ErrForbidden) {
		t.Fatalf("inspect as stranger: %v", err)
	}
}
