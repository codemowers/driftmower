// Package ttlcache provides small in-memory caches with a time bound. Nothing
// here is persistent or shared between processes; a restart starts cold.
package ttlcache

import (
	"container/list"
	"context"
	"sync"
	"time"
)

// Cache is a size-bounded, least-recently-used map whose entries expire. It is
// safe for concurrent use.
type Cache[V any] struct {
	mu         sync.Mutex
	ttl        time.Duration
	maxEntries int
	now        func() time.Time
	order      *list.List // front is most recently used
	entries    map[string]*list.Element
}

// Stats counts retained entries, including expired values which have not yet
// been evicted. KeyBytes measures keys only, not the size of cached values.
type Stats struct{ Entries, Expired, Capacity, Loading, KeyBytes int }

func (c *Cache[V]) Stats() Stats {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := Stats{Entries: len(c.entries), Capacity: c.maxEntries}
	now := c.now()
	for key, el := range c.entries {
		s.KeyBytes += len(key)
		if !now.Before(el.Value.(*entry[V]).expiresAt) {
			s.Expired++
		}
	}
	return s
}

type entry[V any] struct {
	key       string
	value     V
	expiresAt time.Time
}

// New returns a cache whose entries live for ttl and which holds at most
// maxEntries, evicting the least recently used first. now defaults to
// time.Now.
func New[V any](ttl time.Duration, maxEntries int, now func() time.Time) *Cache[V] {
	if now == nil {
		now = time.Now
	}

	return &Cache[V]{
		ttl:        ttl,
		maxEntries: maxEntries,
		now:        now,
		order:      list.New(),
		entries:    map[string]*list.Element{},
	}
}

func (c *Cache[V]) Get(key string) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	var zero V
	el, ok := c.entries[key]
	if !ok {
		return zero, false
	}
	e := el.Value.(*entry[V])
	if !c.now().Before(e.expiresAt) {
		c.remove(el)

		return zero, false
	}
	c.order.MoveToFront(el)

	return e.value, true
}

func (c *Cache[V]) Set(key string, value V) {
	c.SetWithTTL(key, value, c.ttl)
}

func (c *Cache[V]) SetWithTTL(key string, value V, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if el, ok := c.entries[key]; ok {
		c.remove(el)
	}
	c.entries[key] = c.order.PushFront(&entry[V]{key: key, value: value, expiresAt: c.now().Add(ttl)})
	for c.order.Len() > c.maxEntries {
		c.remove(c.order.Back())
	}
}

func (c *Cache[V]) Delete(key string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()

	el, ok := c.entries[key]
	if ok {
		c.remove(el)
	}

	return ok
}

// DeleteWhere removes every entry the predicate selects and reports how many.
func (c *Cache[V]) DeleteWhere(predicate func(key string, value V) bool) int {
	c.mu.Lock()
	defer c.mu.Unlock()

	removed := 0
	for el := c.order.Front(); el != nil; {
		next := el.Next()
		if e := el.Value.(*entry[V]); predicate(e.key, e.value) {
			c.remove(el)
			removed++
		}
		el = next
	}

	return removed
}

func (c *Cache[V]) Clear() int {
	c.mu.Lock()
	defer c.mu.Unlock()

	n := c.order.Len()
	c.order.Init()
	clear(c.entries)

	return n
}

func (c *Cache[V]) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()

	return c.order.Len()
}

func (c *Cache[V]) remove(el *list.Element) {
	c.order.Remove(el)
	delete(c.entries, el.Value.(*entry[V]).key)
}

// Memo caches a single value. Concurrent callers share one in-flight load, and
// a failed load is not remembered, so the next call retries rather than
// serving a cached failure.
type Memo[T any] struct {
	ttl  time.Duration
	load func(context.Context) (T, error)
	now  func() time.Time

	mu        sync.Mutex
	value     T
	expiresAt time.Time
	valid     bool
	loaded    bool
	pending   *call[T]
}

type call[T any] struct {
	done  chan struct{}
	value T
	err   error
}

func NewMemo[T any](ttl time.Duration, load func(context.Context) (T, error), now func() time.Time) *Memo[T] {
	if now == nil {
		now = time.Now
	}

	return &Memo[T]{ttl: ttl, load: load, now: now}
}

// Get returns the cached value or loads it. The shared load is detached from
// any one caller's cancellation; a caller whose context ends stops waiting
// without failing the others.
func (m *Memo[T]) Get(ctx context.Context) (T, error) {
	m.mu.Lock()
	if m.valid && m.now().Before(m.expiresAt) {
		v := m.value
		m.mu.Unlock()

		return v, nil
	}
	c := m.pending
	if c == nil {
		c = &call[T]{done: make(chan struct{})}
		m.pending = c
		go m.run(context.WithoutCancel(ctx), c)
	}
	m.mu.Unlock()

	select {
	case <-c.done:
		return c.value, c.err
	case <-ctx.Done():
		var zero T

		return zero, ctx.Err()
	}
}

func (m *Memo[T]) run(ctx context.Context, c *call[T]) {
	c.value, c.err = m.load(ctx)

	m.mu.Lock()
	if c.err == nil {
		m.value, m.expiresAt, m.valid = c.value, m.now().Add(m.ttl), true
		m.loaded = true
	}
	m.pending = nil
	m.mu.Unlock()
	close(c.done)
}

func (m *Memo[T]) Stats() Stats {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := Stats{Capacity: 1}
	if m.loaded {
		s.Entries = 1
		if !m.valid || !m.now().Before(m.expiresAt) {
			s.Expired = 1
		}
	}
	if m.pending != nil {
		s.Loading = 1
	}
	return s
}

// Invalidate drops the cached value. A load already in flight still stores
// its result when it completes.
func (m *Memo[T]) Invalidate() {
	m.mu.Lock()
	m.valid = false
	m.mu.Unlock()
}
