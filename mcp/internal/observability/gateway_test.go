package observability

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

var okResponse = Response{Status: 200, Body: []byte(`{"status":"success"}`)}

func promQuery(q string) *url.URL {
	u, _ := url.Parse("http://prometheus:9090/api/v1/query?query=" + q)

	return u
}

var lokiURL, _ = url.Parse("http://loki:3100/loki/api/v1/query_range?query=%7Bpod%3D%22a%22%7D")

// fakeBackend records requests and answers through respond.
type fakeBackend struct {
	mu      sync.Mutex
	urls    []*url.URL
	respond func(u *url.URL) (Response, error)
}

func (f *fakeBackend) Get(_ context.Context, u *url.URL) (Response, error) {
	f.mu.Lock()
	f.urls = append(f.urls, u)
	respond := f.respond
	f.mu.Unlock()
	if respond == nil {
		return okResponse, nil
	}

	return respond(u)
}

func (f *fakeBackend) calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()

	return len(f.urls)
}

type outcomes struct {
	mu   sync.Mutex
	list []string
}

func (o *outcomes) add(s string) {
	o.mu.Lock()
	o.list = append(o.list, s)
	o.mu.Unlock()
}

func (o *outcomes) get() []string {
	o.mu.Lock()
	defer o.mu.Unlock()

	return slices.Clone(o.list)
}

func newGateway(t *testing.T, backend Requester, mutate func(*GatewayOptions)) (*Gateway, *outcomes) {
	t.Helper()
	o := &outcomes{}
	opts := GatewayOptions{
		Next: backend, PrometheusURL: "http://prometheus:9090", MaxConcurrent: 2, MaxQueued: 1,
		QueueWait: time.Second, CacheTTL: 15 * time.Second, PrometheusTimeout: 9 * time.Second, OnOutcome: o.add,
	}
	if mutate != nil {
		mutate(&opts)
	}

	return NewGateway(opts), o
}

func TestGatewayAddsPrometheusTimeoutOnlyToQueries(t *testing.T) {
	b := &fakeBackend{}
	g, _ := newGateway(t, b, nil)
	ctx := context.Background()

	_, _ = g.Get(ctx, promQuery("up"))
	_, _ = g.Get(ctx, lokiURL)
	if got := b.urls[0].Query().Get("timeout"); got != "9s" {
		t.Errorf("prometheus timeout = %q", got)
	}
	if b.urls[1].Query().Has("timeout") {
		t.Error("loki request got a timeout parameter")
	}
}

func TestGatewayCachesPrometheusUntilExpiryNeverFailures(t *testing.T) {
	b := &fakeBackend{}
	g, o := newGateway(t, b, func(o *GatewayOptions) { o.CacheTTL = 50 * time.Millisecond })
	ctx := context.Background()

	_, _ = g.Get(ctx, promQuery("up"))
	_, _ = g.Get(ctx, promQuery("up"))
	if b.calls() != 1 {
		t.Fatalf("calls = %d, want cached", b.calls())
	}
	time.Sleep(60 * time.Millisecond)
	_, _ = g.Get(ctx, promQuery("up"))
	if b.calls() != 2 {
		t.Fatalf("calls = %d after expiry", b.calls())
	}

	b.respond = func(*url.URL) (Response, error) { return Response{Status: 503, Body: []byte("overloaded")}, nil }
	_, _ = g.Get(ctx, promQuery("down"))
	_, _ = g.Get(ctx, promQuery("down"))
	if b.calls() != 4 {
		t.Errorf("calls = %d; a failure was cached", b.calls())
	}
	if got := o.get(); !slices.Equal(got, []string{"ok", "cached", "ok", "ok", "ok"}) {
		t.Errorf("outcomes = %v", got)
	}
}

func TestGatewaySharesInFlightButDoesNotCacheLoki(t *testing.T) {
	release := make(chan struct{})
	var started atomic.Int32
	b := &fakeBackend{respond: func(*url.URL) (Response, error) {
		if started.Add(1) == 1 {
			<-release
		}

		return okResponse, nil
	}}
	g, o := newGateway(t, b, nil)
	ctx := context.Background()

	var wg sync.WaitGroup
	wg.Go(func() { _, _ = g.Get(ctx, lokiURL) })
	for started.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	wg.Go(func() { _, _ = g.Get(ctx, lokiURL) })
	// Let the second caller join the flight before releasing it.
	time.Sleep(20 * time.Millisecond)
	close(release)
	wg.Wait()
	_, _ = g.Get(ctx, lokiURL)

	if b.calls() != 2 {
		t.Errorf("calls = %d, want shared then a fresh request", b.calls())
	}
	got := o.get()
	slices.Sort(got)
	if !slices.Equal(got, []string{"ok", "ok", "shared"}) {
		t.Errorf("outcomes = %v", got)
	}
}

func TestGatewayQueuesThenRefuses(t *testing.T) {
	release := map[string]chan struct{}{"a": make(chan struct{}), "b": make(chan struct{}), "c": make(chan struct{})}
	b := &fakeBackend{respond: func(u *url.URL) (Response, error) {
		<-release[u.Query().Get("query")]

		return okResponse, nil
	}}
	g, _ := newGateway(t, b, func(o *GatewayOptions) { o.CacheTTL = 0 })
	ctx := context.Background()

	var wg sync.WaitGroup
	for _, q := range []string{"a", "b"} {
		wg.Go(func() { _, _ = g.Get(ctx, promQuery(q)) })
	}
	for b.calls() < 2 {
		time.Sleep(time.Millisecond)
	}
	wg.Go(func() { _, _ = g.Get(ctx, promQuery("c")) })
	// Wait until c holds the only queue slot.
	for len(g.queue) == 0 {
		time.Sleep(time.Millisecond)
	}

	_, err := g.Get(ctx, promQuery("d"))
	var refused *Refused
	if !errors.As(err, &refused) || refused.Reason != "busy" || refused.RetryAfterSeconds != 1 {
		t.Fatalf("err = %v", err)
	}
	if b.calls() != 2 {
		t.Errorf("calls = %d", b.calls())
	}

	close(release["a"])
	// The freed slot goes to the queued request.
	deadline := time.Now().Add(2 * time.Second)
	for b.calls() < 3 {
		if time.Now().After(deadline) {
			t.Fatal("queued request never ran")
		}
		time.Sleep(time.Millisecond)
	}
	close(release["b"])
	close(release["c"])
	wg.Wait()
}

func TestGatewayRefusesQueuedRequestPastDeadline(t *testing.T) {
	release := make(chan struct{})
	b := &fakeBackend{respond: func(*url.URL) (Response, error) { <-release; return okResponse, nil }}
	g, o := newGateway(t, b, func(o *GatewayOptions) {
		o.CacheTTL, o.MaxConcurrent, o.QueueWait = 0, 1, 30*time.Millisecond
	})
	ctx := context.Background()

	done := make(chan struct{})
	go func() { _, _ = g.Get(ctx, promQuery("a")); close(done) }()
	for b.calls() == 0 {
		time.Sleep(time.Millisecond)
	}
	_, err := g.Get(ctx, promQuery("b"))
	var refused *Refused
	if !errors.As(err, &refused) || refused.Reason != "busy" || !strings.Contains(refused.Message, "30 ms") {
		t.Fatalf("err = %v", err)
	}
	close(release)
	<-done
	if got := o.get(); !slices.Equal(got, []string{"busy", "ok"}) {
		t.Errorf("outcomes = %v", got)
	}
}

func TestBudgetChargesEveryBackendRequest(t *testing.T) {
	now := time.Unix(0, 0)
	b := &Budget{QueriesPerMinute: 10, MaxConcurrentCalls: 5, Now: func() time.Time { return now }}

	_ = b.Admit("alice", func(charge func()) error {
		for range 12 {
			charge()
		}

		return nil
	})
	// 10 - 12 = -2: the next query needs 3 more tokens, 18 s at 10 per minute.
	err := b.Admit("alice", func(func()) error { return nil })
	var refused *Refused
	if !errors.As(err, &refused) || refused.Reason != "rate_limited" || refused.RetryAfterSeconds != 18 {
		t.Fatalf("err = %v", err)
	}
	if err := b.Admit("bob", func(func()) error { return nil }); err != nil {
		t.Errorf("bob has his own budget: %v", err)
	}
	now = now.Add(18 * time.Second)
	if err := b.Admit("alice", func(func()) error { return nil }); err != nil {
		t.Errorf("refilled: %v", err)
	}
}

func TestBudgetCapsCallsInFlight(t *testing.T) {
	b := &Budget{MaxConcurrentCalls: 1}
	release := make(chan struct{})
	started := make(chan struct{})
	done := make(chan error)
	go func() {
		done <- b.Admit("alice", func(func()) error { close(started); <-release; return nil })
	}()
	<-started

	err := b.Admit("alice", func(func()) error { return nil })
	var refused *Refused
	if !errors.As(err, &refused) || refused.Reason != "caller_busy" {
		t.Fatalf("err = %v", err)
	}
	close(release)
	<-done

	boom := errors.New("backend down")
	if err := b.Admit("alice", func(func()) error { return boom }); !errors.Is(err, boom) {
		t.Errorf("err = %v", err)
	}
	if err := b.Admit("alice", func(func()) error { return nil }); err != nil {
		t.Errorf("slot not released after failure: %v", err)
	}
}

func TestBudgetNeverForgetsBusyCaller(t *testing.T) {
	b := &Budget{MaxConcurrentCalls: 1, MaxCallers: 1}
	release := make(chan struct{})
	started := make(chan struct{})
	done := make(chan error)
	go func() {
		done <- b.Admit("alice", func(func()) error { close(started); <-release; return nil })
	}()
	<-started

	_ = b.Admit("bob", func(func()) error { return nil })
	err := b.Admit("alice", func(func()) error { return nil })
	var refused *Refused
	if !errors.As(err, &refused) || refused.Reason != "caller_busy" {
		t.Errorf("err = %v; a caller with a call in flight was forgotten", err)
	}
	close(release)
	<-done
}

func TestHTTPRequesterDoesNotFollowRedirects(t *testing.T) {
	var requests atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.Header().Set("Location", "/another-service")
		w.WriteHeader(http.StatusFound)
		_, _ = w.Write([]byte("redirect"))
	}))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)

	resp, err := HTTPRequester(time.Second).Get(context.Background(), u)
	if err != nil || resp.Status != 302 || string(resp.Body) != "redirect" || requests.Load() != 1 {
		t.Errorf("resp = %d %q, err %v, requests %d", resp.Status, resp.Body, err, requests.Load())
	}
}

func TestHTTPRequesterBoundsBodyAndTime(t *testing.T) {
	large := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", 4<<20+1)))
	}))
	defer large.Close()
	u, _ := url.Parse(large.URL)
	if _, err := HTTPRequester(5*time.Second).Get(context.Background(), u); err == nil || !strings.Contains(err.Error(), "exceeds 4 MiB") {
		t.Errorf("large body err = %v", err)
	}

	stuck := make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte("partial"))
		w.(http.Flusher).Flush()
		<-stuck
	}))
	defer slow.Close()
	defer close(stuck)
	u, _ = url.Parse(slow.URL)
	if _, err := HTTPRequester(50*time.Millisecond).Get(context.Background(), u); err == nil {
		t.Error("an unfinished body was accepted")
	}
}
