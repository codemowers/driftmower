package observability

import (
	"context"
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
		Next: backend, PrometheusURL: "http://prometheus:9090",
		PrometheusTimeout: 9 * time.Second, OnOutcome: o.add,
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

func TestGatewayDoesNotRetainCompletedPrometheusResponses(t *testing.T) {
	b := &fakeBackend{}
	g, _ := newGateway(t, b, nil)
	for range 3 {
		_, _ = g.Get(context.Background(), promQuery("up"))
	}
	if b.calls() != 3 {
		t.Fatalf("calls = %d, want a fresh request every time", b.calls())
	}
}

func TestGatewayRunsDistinctQueriesConcurrently(t *testing.T) {
	const requests = 16
	started := make(chan struct{}, requests)
	release := make(chan struct{})
	backend := RequesterFunc(func(context.Context, *url.URL) (Response, error) {
		started <- struct{}{}
		<-release
		return okResponse, nil
	})
	gateway, _ := newGateway(t, backend, nil)
	results := make(chan error, requests)
	var workers sync.WaitGroup
	defer workers.Wait()
	defer close(release)
	for i := range requests {
		workers.Go(func() {
			u := promQuery("up")
			q := u.Query()
			q.Set("time", time.Unix(int64(i), 0).Format(time.RFC3339))
			u.RawQuery = q.Encode()
			_, err := gateway.Get(context.Background(), u)
			results <- err
		})
	}
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	for range requests {
		select {
		case <-started:
		case err := <-results:
			t.Fatalf("request returned before backend release: %v", err)
		case <-timer.C:
			t.Fatal("concurrent queries did not all reach the backend")
		}
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
