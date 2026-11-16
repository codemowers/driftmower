// Package useraccess lists Passmower OIDCUsers and reports what Kubernetes
// lets each of them do. Effective rights are the authorizer's own answer:
// SelfSubjectRulesReviews sent while impersonating the user, never a reading
// of RoleBindings by this server.
package useraccess

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
)

var OIDCUsersGVR = schema.GroupVersionResource{Group: "codemowers.cloud", Version: "v1", Resource: "oidcusers"}

// User is the public summary of one OIDCUser. Credentials and verification
// records are never copied out.
type User struct {
	Name         string   `json:"name"`
	Namespace    string   `json:"namespace"`
	Type         string   `json:"type,omitempty"`
	DisplayName  string   `json:"displayName,omitempty"`
	PrimaryEmail string   `json:"primaryEmail,omitempty"`
	Emails       []string `json:"emails"`
	// Groups as the token carries them, `<prefix>:<name>`.
	Groups           []string          `json:"groups"`
	Memberships      []GroupMembership `json:"memberships"`
	LocalEmail       string            `json:"localEmail,omitempty"`
	CompanyEmail     string            `json:"companyEmail,omitempty"`
	LocalDisplayName string            `json:"localDisplayName,omitempty"`
	Approved         *bool             `json:"approved,omitempty"`
	PasskeyCount     int64             `json:"passkeyCount"`
	LastSignIn       *time.Time        `json:"lastSignIn,omitempty"`
	// The application of the most recent sign-in, `<namespace>/<name>`.
	LastApplication string `json:"lastApplication,omitempty"`
}

// Membership retains the source of an assignment, independently of its prefix.
// For example spec.groups can contain any locally assigned group prefix.
type GroupMembership struct {
	Prefix string `json:"prefix"`
	Name   string `json:"name"`
	Source string `json:"source"`
	Local  bool   `json:"local"`
}

func userFrom(obj *unstructured.Unstructured) User {
	u := User{Name: obj.GetName(), Namespace: obj.GetNamespace(), Emails: []string{}, Groups: []string{}, Memberships: []GroupMembership{}}
	u.Type, _, _ = unstructured.NestedString(obj.Object, "spec", "type")
	u.LocalEmail, _, _ = unstructured.NestedString(obj.Object, "spec", "email")
	u.CompanyEmail, _, _ = unstructured.NestedString(obj.Object, "spec", "companyEmail")
	u.LocalDisplayName, _, _ = unstructured.NestedString(obj.Object, "passmower", "name")
	if value, found, _ := unstructured.NestedBool(obj.Object, "passmower", "approved"); found {
		u.Approved = &value
	}
	sources := []string{}
	for source := range obj.Object {
		if source != "status" && source != "metadata" {
			sources = append(sources, source)
		}
	}
	slices.Sort(sources)
	for _, source := range sources {
		groups, _, _ := unstructured.NestedSlice(obj.Object, source, "groups")
		for _, raw := range groups {
			g, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			name, _ := g["name"].(string)
			prefix, _ := g["prefix"].(string)
			if name != "" {
				u.Memberships = append(u.Memberships, GroupMembership{Prefix: prefix, Name: name, Source: source, Local: source == "spec" || source == "passmower"})
			}
		}
	}
	u.DisplayName, _, _ = unstructured.NestedString(obj.Object, "status", "profile", "name")
	u.PrimaryEmail, _, _ = unstructured.NestedString(obj.Object, "status", "primaryEmail")
	if emails, _, _ := unstructured.NestedStringSlice(obj.Object, "status", "emails"); emails != nil {
		u.Emails = emails
	}
	u.PasskeyCount, _, _ = unstructured.NestedInt64(obj.Object, "status", "passkeyCount")
	groups, _, _ := unstructured.NestedSlice(obj.Object, "status", "groups")
	for _, g := range groups {
		m, ok := g.(map[string]any)
		if !ok {
			continue
		}
		name, _ := m["name"].(string)
		prefix, _ := m["prefix"].(string)
		if name == "" {
			continue
		}
		if prefix != "" {
			name = prefix + ":" + name
		}
		if !slices.Contains(u.Groups, name) {
			u.Groups = append(u.Groups, name)
		}
	}
	apps, _, _ := unstructured.NestedSlice(obj.Object, "status", "recentApplications")
	for _, a := range apps {
		m, ok := a.(map[string]any)
		if !ok {
			continue
		}
		at, _ := m["lastAuthenticatedAt"].(string)
		t, err := time.Parse(time.RFC3339Nano, at)
		if err != nil || (u.LastSignIn != nil && !t.After(*u.LastSignIn)) {
			continue
		}
		u.LastSignIn = &t
		ns, _ := m["clientNamespace"].(string)
		name, _ := m["clientName"].(string)
		u.LastApplication = ns + "/" + name
	}

	return u
}

// ErrUnmappable reports an OIDCUser whose Kubernetes username this server
// cannot reproduce from the resource alone.
var ErrUnmappable = errors.New("the Kubernetes username of this OIDCUser cannot be derived")

// Identity reproduces the Kubernetes subject the API server assigns this
// user's tokens, as auth.KubernetesIdentity does for a verified caller.
// Passmower issues the OIDCUser name as `sub` and groups as
// `<prefix>:<name>`.
func Identity(u User, m auth.Mapping) (authz.Identity, error) {
	var username string
	switch m.UsernameClaim {
	case "sub", "":
		username = u.Name
	case "email":
		username = u.PrimaryEmail
	default:
		return authz.Identity{}, fmt.Errorf("%w: username claim %q is not stored on OIDCUsers", ErrUnmappable, m.UsernameClaim)
	}
	if username == "" {
		return authz.Identity{}, fmt.Errorf("%w: the OIDCUser has no %s", ErrUnmappable, m.UsernameClaim)
	}
	groups := []string{"system:authenticated"}
	for _, g := range u.Groups {
		if g = m.GroupsPrefix + g; !slices.Contains(groups, g) {
			groups = append(groups, g)
		}
	}

	return authz.Identity{User: m.UsernamePrefix + username, Groups: groups}, nil
}

// ListUsers returns every OIDCUser, sorted by name, once the caller may list
// them.
func (s *Service) ListUsers(ctx context.Context, caller authz.Identity) ([]User, error) {
	if err := s.require(ctx, caller, authz.Attributes{Namespace: s.Namespace, Group: OIDCUsersGVR.Group, Resource: OIDCUsersGVR.Resource, Verb: "list"}); err != nil {
		return nil, err
	}
	list, err := s.Dynamic.Resource(OIDCUsersGVR).Namespace(s.Namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list OIDCUsers in %s: %w", s.Namespace, err)
	}
	users := make([]User, 0, len(list.Items))
	for i := range list.Items {
		users = append(users, userFrom(&list.Items[i]))
	}
	slices.SortFunc(users, func(a, b User) int {
		switch {
		case a.Name < b.Name:
			return -1
		case a.Name > b.Name:
			return 1
		}

		return 0
	})

	return users, nil
}

func (s *Service) getUser(ctx context.Context, name string) (User, error) {
	obj, err := s.Dynamic.Resource(OIDCUsersGVR).Namespace(s.Namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return User{}, fmt.Errorf("get OIDCUser %s/%s: %w", s.Namespace, name, err)
	}

	return userFrom(obj), nil
}
