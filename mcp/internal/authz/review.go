// Package authz answers "may this caller do X" with the cluster's own
// authorizer, through SubjectAccessReviews sent by this server's
// ServiceAccount.
package authz

import (
	"context"
	"errors"
	"slices"
	"strings"

	authorizationv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	authorizationclient "k8s.io/client-go/kubernetes/typed/authorization/v1"
)

type Identity struct {
	User   string   `json:"user"`
	Groups []string `json:"groups"`
}

// Key identifies the subject regardless of group order.
func (i Identity) Key() string {
	groups := slices.Clone(i.Groups)
	slices.Sort(groups)

	return i.User + "\x00" + strings.Join(groups, ",")
}

// Attributes are the resource attributes of one review. An empty Namespace
// means "in all namespaces" for namespaced resources.
type Attributes struct {
	Namespace   string `json:"namespace,omitempty"`
	Verb        string `json:"verb"`
	Group       string `json:"group"`
	Resource    string `json:"resource"`
	Subresource string `json:"subresource,omitempty"`
	Name        string `json:"name,omitempty"`
}

// String describes the attributes for a human, e.g.
// `get pods/log.core "api" in namespace a`.
func (a Attributes) String() string {
	resource := a.Resource
	if a.Subresource != "" {
		resource += "/" + a.Subresource
	}
	group := a.Group
	if group == "" {
		group = "core"
	}
	s := a.Verb + " " + resource + "." + group
	if a.Name != "" {
		s += ` "` + a.Name + `"`
	}
	if a.Namespace != "" {
		return s + " in namespace " + a.Namespace
	}

	return s + " cluster-wide"
}

func (a Attributes) key() string {
	return strings.Join([]string{a.Namespace, a.Group, a.Resource, a.Subresource, a.Name, a.Verb}, "\x00")
}

// Reviewer answers one access question conclusively, or returns an error.
type Reviewer interface {
	Allowed(ctx context.Context, id Identity, attrs Attributes) (bool, error)
}

// ErrInconclusive reports a review the authorizer could not evaluate.
var ErrInconclusive = errors.New("Kubernetes access review was inconclusive") //nolint:staticcheck // Kubernetes is a proper noun.

type subjectAccessReviewer struct {
	client authorizationclient.SubjectAccessReviewsGetter
}

// NewSubjectAccessReviewer sends a SubjectAccessReview per question.
func NewSubjectAccessReviewer(client authorizationclient.SubjectAccessReviewsGetter) Reviewer {
	return &subjectAccessReviewer{client: client}
}

func (r *subjectAccessReviewer) Allowed(ctx context.Context, id Identity, attrs Attributes) (bool, error) {
	review, err := r.client.SubjectAccessReviews().Create(ctx, &authorizationv1.SubjectAccessReview{
		Spec: authorizationv1.SubjectAccessReviewSpec{
			User:   id.User,
			Groups: id.Groups,
			ResourceAttributes: &authorizationv1.ResourceAttributes{
				Namespace:   attrs.Namespace,
				Verb:        attrs.Verb,
				Group:       attrs.Group,
				Resource:    attrs.Resource,
				Subresource: attrs.Subresource,
				Name:        attrs.Name,
			},
		},
	}, metav1.CreateOptions{})
	if err != nil {
		return false, err
	}
	// An evaluation error means some authorizer could not answer; a "no" from
	// the remaining ones is not conclusive.
	if review.Status.EvaluationError != "" {
		return false, ErrInconclusive
	}

	return review.Status.Allowed && !review.Status.Denied, nil
}
