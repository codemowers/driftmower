// Package authz authenticates callers by projected ServiceAccount token and
// checks their Kubernetes permissions, so cached cluster data is only ever
// returned as the caller could read it.
package authz

import (
	"context"
	"crypto/sha256"
	"errors"
	"slices"
	"strings"
	"sync"
	"time"

	authnv1 "k8s.io/api/authentication/v1"
	authzv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

const (
	tokenTTL    = time.Minute
	decisionTTL = 30 * time.Second
	maxEntries  = 10_000
)

// Identity is an authenticated caller.
type Identity struct {
	User   string
	UID    string
	Groups []string
	Extra  map[string]authzv1.ExtraValue
}

func (id *Identity) key() string {
	return id.User + "\x00" + strings.Join(id.Groups, "\x00")
}

// Attributes name a permission check.
type Attributes struct {
	Namespace, Group, Resource, Verb string
}

type Authorizer struct {
	client   kubernetes.Interface
	audience string

	mu        sync.Mutex
	tokens    map[[32]byte]entry[*Identity]
	decisions map[string]entry[bool]
}

type entry[T any] struct {
	value   T
	expires time.Time
}

func New(client kubernetes.Interface, audience string) *Authorizer {
	return &Authorizer{client: client, audience: audience, tokens: map[[32]byte]entry[*Identity]{}, decisions: map[string]entry[bool]{}}
}

// Authenticate reviews a bearer token for this server's audience.
func (a *Authorizer) Authenticate(ctx context.Context, token string) (*Identity, error) {
	if token == "" {
		return nil, errors.New("missing bearer token")
	}
	sum := sha256.Sum256([]byte(token))
	if id, ok := lookup(a, a.tokens, sum); ok {
		return id, nil
	}
	review, err := a.client.AuthenticationV1().TokenReviews().Create(ctx, &authnv1.TokenReview{
		Spec: authnv1.TokenReviewSpec{Token: token, Audiences: []string{a.audience}}}, metav1.CreateOptions{})
	if err != nil {
		return nil, err
	}
	if !review.Status.Authenticated || review.Status.Error != "" || !slices.Contains(review.Status.Audiences, a.audience) {
		return nil, errors.New("token rejected")
	}
	user := review.Status.User
	id := &Identity{User: user.Username, UID: user.UID, Groups: user.Groups, Extra: map[string]authzv1.ExtraValue{}}
	for key, value := range user.Extra {
		id.Extra[key] = authzv1.ExtraValue(value)
	}
	store(a, a.tokens, sum, id, tokenTTL)
	return id, nil
}

// Allowed reports whether id may perform the check. A cluster-wide grant
// answers namespaced checks too.
func (a *Authorizer) Allowed(ctx context.Context, id *Identity, attrs Attributes) (bool, error) {
	if attrs.Namespace != "" {
		cluster := attrs
		cluster.Namespace = ""
		if allowed, err := a.allowed(ctx, id, cluster); err != nil || allowed {
			return allowed, err
		}
	}
	return a.allowed(ctx, id, attrs)
}

func (a *Authorizer) allowed(ctx context.Context, id *Identity, attrs Attributes) (bool, error) {
	key := id.key() + "\x01" + attrs.Namespace + "\x00" + attrs.Group + "\x00" + attrs.Resource + "\x00" + attrs.Verb
	if allowed, ok := lookup(a, a.decisions, key); ok {
		return allowed, nil
	}
	review, err := a.client.AuthorizationV1().SubjectAccessReviews().Create(ctx, &authzv1.SubjectAccessReview{Spec: authzv1.SubjectAccessReviewSpec{
		User: id.User, UID: id.UID, Groups: id.Groups, Extra: id.Extra,
		ResourceAttributes: &authzv1.ResourceAttributes{Namespace: attrs.Namespace, Group: attrs.Group, Resource: attrs.Resource, Verb: attrs.Verb},
	}}, metav1.CreateOptions{})
	if err != nil {
		return false, err
	}
	store(a, a.decisions, key, review.Status.Allowed, decisionTTL)
	return review.Status.Allowed, nil
}

func lookup[K comparable, V any](a *Authorizer, m map[K]entry[V], key K) (V, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	e, ok := m[key]
	if !ok || time.Now().After(e.expires) {
		var zero V
		return zero, false
	}
	return e.value, true
}

func store[K comparable, V any](a *Authorizer, m map[K]entry[V], key K, value V, ttl time.Duration) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(m) >= maxEntries {
		now := time.Now()
		for k, e := range m {
			if now.After(e.expires) {
				delete(m, k)
			}
		}
		if len(m) >= maxEntries {
			clear(m)
		}
	}
	m[key] = entry[V]{value: value, expires: time.Now().Add(ttl)}
}
