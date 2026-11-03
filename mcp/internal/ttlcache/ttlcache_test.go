package ttlcache

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time          { return c.t }
func (c *clock) advance(d time.Duration) { c.t = c.t.Add(d) }
func newClock() *clock                   { return &clock{t: time.Unix(0, 0)} }

func TestCacheExpiresEntries(t *testing.T) {
	clk := newClock()
	c := New[int](100*time.Millisecond, 10, clk.now)

	c.Set("a", 1)
	if v, ok := c.Get("a"); !ok || v != 1 {
		t.Fatalf("Get = %v %v", v, ok)
	}
	clk.advance(100 * time.Millisecond)
	if _, ok := c.Get("a"); ok {
		t.Error("entry outlived its TTL")
	}
	if c.Len() != 0 {
		t.Errorf("expired entry kept, Len = %d", c.Len())
	}

	c.SetWithTTL("b", 2, time.Second)
	clk.advance(500 * time.Millisecond)
	if _, ok := c.Get("b"); !ok {
		t.Error("per-entry TTL ignored")
	}
}

func TestCacheEvictsLeastRecentlyUsed(t *testing.T) {
	c := New[int](time.Hour, 2, nil)

	c.Set("a", 1)
	c.Set("b", 2)
	c.Get("a")
	c.Set("c", 3)

	if _, ok := c.Get("b"); ok {
		t.Error("b should have been evicted")
	}
	for _, k := range []string{"a", "c"} {
		if _, ok := c.Get(k); !ok {
			t.Errorf("%s evicted", k)
		}
	}
}

func TestCacheDeleteWhereAndClear(t *testing.T) {
	c := New[string](time.Hour, 10, nil)
	c.Set("1", "x")
	c.Set("2", "y")
	c.Set("3", "x")

	if n := c.DeleteWhere(func(_ string, v string) bool { return v == "x" }); n != 2 {
		t.Errorf("DeleteWhere = %d", n)
	}
	if !c.Delete("2") || c.Delete("2") {
		t.Error("Delete reported wrongly")
	}
	c.Set("4", "z")
	if n := c.Clear(); n != 1 || c.Len() != 0 {
		t.Errorf("Clear = %d, Len = %d", n, c.Len())
	}
}

func TestMemoSharesLoadsAndRetriesFailures(t *testing.T) {
	clk := newClock()
	var calls atomic.Int32
	release := make(chan struct{})
	fail := true
	m := NewMemo(time.Minute, func(context.Context) (int, error) {
		n := calls.Add(1)
		<-release
		if fail {
			return 0, errors.New("boom")
		}

		return int(n), nil
	}, clk.now)

	var wg sync.WaitGroup
	errs := make([]error, 3)
	for i := range errs {
		wg.Go(func() { _, errs[i] = m.Get(context.Background()) })
	}
	for calls.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	close(release)
	wg.Wait()
	for _, err := range errs {
		if err == nil {
			t.Fatal("shared load should have failed")
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d, want one shared load", calls.Load())
	}

	fail = false
	if v, err := m.Get(context.Background()); err != nil || v != 2 {
		t.Fatalf("retry = %v %v", v, err)
	}
	if v, _ := m.Get(context.Background()); v != 2 {
		t.Errorf("cached value = %d", v)
	}

	m.Invalidate()
	if v, _ := m.Get(context.Background()); v != 3 {
		t.Errorf("after Invalidate = %d", v)
	}
	clk.advance(time.Minute)
	if v, _ := m.Get(context.Background()); v != 4 {
		t.Errorf("after expiry = %d", v)
	}
}

func TestMemoWaiterCancellation(t *testing.T) {
	release := make(chan struct{})
	m := NewMemo(time.Minute, func(ctx context.Context) (string, error) {
		<-release

		return "ok", ctx.Err()
	}, nil)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := m.Get(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	close(release)
	if v, err := m.Get(context.Background()); err != nil || v != "ok" {
		t.Errorf("shared load was cancelled with its first caller: %q %v", v, err)
	}
}
