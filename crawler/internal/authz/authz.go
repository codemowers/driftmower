// Package authz authenticates callers by projected ServiceAccount token.
package authz

import (
	"context"
	"crypto/sha256"
	"errors"
	"slices"
	"sync"
	"time"

	authnv1 "k8s.io/api/authentication/v1"
	authzv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

const (
	tokenTTL   = time.Minute
	maxEntries = 10_000
)

// Identity is an authenticated caller.
type Identity struct {
	User   string
	UID    string
	Groups []string
	Extra  map[string]authzv1.ExtraValue
}

type Authorizer struct {
	client   kubernetes.Interface
	audience string

	mu     sync.Mutex
	tokens map[[32]byte]entry[*Identity]
}

type entry[T any] struct {
	value   T
	expires time.Time
}

func New(client kubernetes.Interface, audience string) *Authorizer {
	return &Authorizer{client: client, audience: audience, tokens: map[[32]byte]entry[*Identity]{}}
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
