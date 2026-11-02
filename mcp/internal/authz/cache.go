package authz

import (
	"context"
	"time"

	"golang.org/x/sync/singleflight"

	"github.com/codemowers/driftmower-mcp/internal/ttlcache"
)

// CachedReviewer is the one cache under every review this server sends.
//
// Caching here rather than in each consumer means the scope sweep, the access
// matrix and the exact per-action checks agree with each other inside a
// window, and there is one place that decides how stale an answer may be.
//
// Only conclusive answers are stored. A review the API server could not
// evaluate returns an error, is not cached, and is retried on the next call.
//
// Freshness comes from invalidation (RBAC watch, webhook), with the TTL as the
// safety net.
type CachedReviewer struct {
	inner   Reviewer
	enabled bool
	cache   *ttlcache.Cache[answer]
	flight  singleflight.Group
}

type answer struct {
	allowed   bool
	namespace string
	user      string
}

const maxCachedReviews = 50_000

// NewCachedReviewer caches inner's answers for ttl; zero disables caching.
func NewCachedReviewer(inner Reviewer, ttl time.Duration, now func() time.Time) *CachedReviewer {
	return &CachedReviewer{
		inner:   inner,
		enabled: ttl > 0,
		cache:   ttlcache.New[answer](ttl, maxCachedReviews, now),
	}
}

func (c *CachedReviewer) Allowed(ctx context.Context, id Identity, attrs Attributes) (bool, error) {
	if !c.enabled {
		return c.inner.Allowed(ctx, id, attrs)
	}

	key := id.Key() + "\x00" + attrs.key()
	if hit, ok := c.cache.Get(key); ok {
		return hit.allowed, nil
	}

	// Identical concurrent reviews share one request. It is detached from the
	// first caller's cancellation so that caller cannot fail the others.
	result := c.flight.DoChan(key, func() (any, error) {
		allowed, err := c.inner.Allowed(context.WithoutCancel(ctx), id, attrs)
		if err == nil {
			c.cache.Set(key, answer{allowed: allowed, namespace: attrs.Namespace, user: id.User})
		}

		return allowed, err
	})
	select {
	case r := <-result:
		if r.Err != nil {
			return false, r.Err
		}

		return r.Val.(bool), nil
	case <-ctx.Done():
		return false, ctx.Err()
	}
}

// InvalidateNamespace drops answers about one namespace. Cluster-wide answers
// are stored under the empty namespace.
func (c *CachedReviewer) InvalidateNamespace(namespace string) int {
	return c.cache.DeleteWhere(func(_ string, a answer) bool { return a.namespace == namespace })
}

// InvalidateUser drops every answer for a Kubernetes username, whatever groups
// it was reviewed with.
func (c *CachedReviewer) InvalidateUser(user string) int {
	return c.cache.DeleteWhere(func(_ string, a answer) bool { return a.user == user })
}

// Clear drops every answer and reports how many there were.
func (c *CachedReviewer) Clear() int {
	return c.cache.Clear()
}

func (c *CachedReviewer) Len() int {
	return c.cache.Len()
}
