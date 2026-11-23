package useraccess

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
)

var (
	serviceAccountsGVR     = schema.GroupVersionResource{Version: "v1", Resource: "serviceaccounts"}
	roleBindingsGVR        = schema.GroupVersionResource{Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "rolebindings"}
	clusterRoleBindingsGVR = schema.GroupVersionResource{Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "clusterrolebindings"}
)

const serviceAccountPrefix = "system:serviceaccount:"

// Subject names the account behind a Kubernetes username, as far as it can
// be told from the name alone: a ServiceAccount, or the OIDCUser whose
// tokens carry it.
type Subject struct {
	Username       string             `json:"username"`
	OIDCUser       string             `json:"oidcUser,omitempty"`
	ServiceAccount *ServiceAccountRef `json:"serviceAccount,omitempty"`
}

type ServiceAccountRef struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
}

// SubjectOf undoes the API server's username mapping. An OIDCUser is named
// only when usernames are its sub, which Passmower issues as the OIDCUser
// name.
func SubjectOf(username string, m auth.Mapping) Subject {
	s := Subject{Username: username}
	if rest, ok := strings.CutPrefix(username, serviceAccountPrefix); ok {
		if ns, name, ok := strings.Cut(rest, ":"); ok && ns != "" && name != "" {
			s.ServiceAccount = &ServiceAccountRef{Namespace: ns, Name: name}
		}

		return s
	}
	if strings.HasPrefix(username, "system:") || (m.UsernameClaim != "sub" && m.UsernameClaim != "") {
		return s
	}
	if sub, ok := strings.CutPrefix(username, m.UsernamePrefix); ok && sub != "" {
		s.OIDCUser = sub
	}

	return s
}

type ServiceAccount struct {
	Namespace string    `json:"namespace"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
	// Who created it, as admission recorded.
	CreatedBy *Subject `json:"createdBy,omitempty"`
	// A RoleBinding or ClusterRoleBinding names it as a subject. Bindings to
	// its groups, which every ServiceAccount shares, do not count.
	Bound bool `json:"bound"`
}

// ListServiceAccounts returns every ServiceAccount, sorted by namespace and
// name, once the caller may list them and the bindings cluster-wide.
func (s *Service) ListServiceAccounts(ctx context.Context, caller authz.Identity) ([]ServiceAccount, error) {
	if err := s.require(ctx, caller, authz.Attributes{Resource: "serviceaccounts", Verb: "list"},
		authz.Attributes{Group: roleBindingsGVR.Group, Resource: roleBindingsGVR.Resource, Verb: "list"},
		authz.Attributes{Group: clusterRoleBindingsGVR.Group, Resource: clusterRoleBindingsGVR.Resource, Verb: "list"}); err != nil {
		return nil, err
	}
	list, err := s.Dynamic.Resource(serviceAccountsGVR).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list ServiceAccounts: %w", err)
	}
	bound, err := s.boundServiceAccounts(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]ServiceAccount, 0, len(list.Items))
	for _, item := range list.Items {
		sa := ServiceAccount{Namespace: item.GetNamespace(), Name: item.GetName(), CreatedAt: item.GetCreationTimestamp().UTC(),
			Bound: bound[ServiceAccountRef{Namespace: item.GetNamespace(), Name: item.GetName()}]}
		if by := item.GetAnnotations()["codemowers.io/created-by"]; by != "" {
			subject := SubjectOf(by, s.Mapping)
			sa.CreatedBy = &subject
		}
		out = append(out, sa)
	}
	slices.SortFunc(out, func(a, b ServiceAccount) int {
		return strings.Compare(a.Namespace+"/"+a.Name, b.Namespace+"/"+b.Name)
	})

	return out, nil
}

// InspectServiceAccount evaluates a ServiceAccount's effective rights for a
// caller who may read it and impersonate it, as this server does on their
// behalf.
func (s *Service) InspectServiceAccount(ctx context.Context, caller authz.Identity, namespace, name string, refresh bool) (*Access, error) {
	if err := s.require(ctx, caller,
		authz.Attributes{Namespace: namespace, Resource: "serviceaccounts", Verb: "get", Name: name},
		authz.Attributes{Namespace: namespace, Resource: "serviceaccounts", Verb: "impersonate", Name: name},
		authz.Attributes{Resource: "groups", Verb: "impersonate"},
	); err != nil {
		return nil, err
	}
	if _, err := s.Dynamic.Resource(serviceAccountsGVR).Namespace(namespace).Get(ctx, name, metav1.GetOptions{}); err != nil {
		return nil, fmt.Errorf("get ServiceAccount %s/%s: %w", namespace, name, err)
	}
	id := authz.Identity{User: serviceAccountPrefix + namespace + ":" + name,
		Groups: []string{"system:serviceaccounts", "system:serviceaccounts:" + namespace, "system:authenticated"}}

	return s.cached(ctx, User{Name: name, Namespace: namespace, Type: "ServiceAccount", Emails: []string{}, Groups: id.Groups}, id, refresh)
}

// boundServiceAccounts returns the ServiceAccounts that bindings name.
func (s *Service) boundServiceAccounts(ctx context.Context) (map[ServiceAccountRef]bool, error) {
	bound := map[ServiceAccountRef]bool{}
	for _, gvr := range []schema.GroupVersionResource{roleBindingsGVR, clusterRoleBindingsGVR} {
		list, err := s.Dynamic.Resource(gvr).List(ctx, metav1.ListOptions{})
		if err != nil {
			return nil, fmt.Errorf("list %s: %w", gvr.Resource, err)
		}
		for _, item := range list.Items {
			subjects, _, _ := unstructured.NestedSlice(item.Object, "subjects")
			for _, subject := range subjects {
				m, _ := subject.(map[string]any)
				if kind, _ := m["kind"].(string); kind != "ServiceAccount" {
					continue
				}
				ns, _ := m["namespace"].(string)
				if ns == "" {
					// A RoleBinding's subject defaults to the binding's namespace.
					ns = item.GetNamespace()
				}
				name, _ := m["name"].(string)
				bound[ServiceAccountRef{Namespace: ns, Name: name}] = true
			}
		}
	}

	return bound, nil
}
