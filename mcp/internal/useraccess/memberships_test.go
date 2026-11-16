package useraccess

import (
	"encoding/json"
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestUserMembershipsRetainLocalAndProviderSourcesWithoutCredentials(t *testing.T) {
	obj := &unstructured.Unstructured{Object: map[string]any{
		"metadata":  map[string]any{"name": "alice", "namespace": "passmower"},
		"spec":      map[string]any{"type": "person", "groups": []any{map[string]any{"prefix": "github.com", "name": "manual"}}, "email": "local@example.com"},
		"passmower": map[string]any{"approved": false, "groups": []any{map[string]any{"prefix": "local", "name": "legacy"}}},
		"github":    map[string]any{"groups": []any{map[string]any{"prefix": "github.com", "name": "org:admins"}}, "accessToken": "must-not-leak"},
		"status":    map[string]any{"groups": []any{map[string]any{"prefix": "github.com", "name": "org:admins"}}},
	}}
	u := userFrom(obj)
	if len(u.Memberships) != 3 || u.Approved == nil || *u.Approved || u.LocalEmail != "local@example.com" {
		t.Fatalf("administration metadata missing: %+v", u)
	}
	for _, membership := range u.Memberships {
		if membership.Local != (membership.Source != "github") {
			t.Fatalf("source inferred from group prefix: %+v", membership)
		}
	}
	body, err := json.Marshal(u)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "must-not-leak") || strings.Contains(string(body), "accessToken") {
		t.Fatal("provider credentials exposed")
	}
}
