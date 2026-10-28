// Package observability answers metrics, logs, resource-usage and volume
// questions from Prometheus, Loki and the Kubernetes API, behind guards that
// keep one caller from exhausting the shared backends.
package observability

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/sync/singleflight"

	"github.com/codemowers/driftmower-mcp/internal/ttlcache"
)

// Response is a backend answer. Status is not checked here; callers decide.
type Response struct {
	Status int
	Body   []byte
}

// Requester performs a GET.
type Requester interface {
	Get(ctx context.Context, u *url.URL) (Response, error)
}

type RequesterFunc func(ctx context.Context, u *url.URL) (Response, error)

func (f RequesterFunc) Get(ctx context.Context, u *url.URL) (Response, error) { return f(ctx, u) }

const maxBody = 4 << 20

// HTTPRequester follows no redirects, bounds the body at 4 MiB and the whole
// exchange by the timeout.
func HTTPRequester(timeout time.Duration) Requester {
	client := &http.Client{
		Timeout:       timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}

	return RequesterFunc(func(ctx context.Context, u *url.URL) (Response, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
		if err != nil {
			return Response{}, err
		}
		resp, err := client.Do(req)
		if err != nil {
			return Response{}, err
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
		if err != nil {
			return Response{}, err
		}
		if len(body) > maxBody {
			return Response{}, errors.New("observability response exceeds 4 MiB; narrow the query")
		}

		return Response{Status: resp.StatusCode, Body: body}, nil
	})
}

// Refused is an immediate refusal with a retry hint; nothing waits
// unboundedly.
type Refused struct {
	// busy, rate_limited or caller_busy.
	Reason            string
	RetryAfterSeconds int
	Message           string
}

func (r *Refused) Error() string { return r.Message }

// GatewayOptions configure the server-wide guard in front of Prometheus and
// Loki, which every tenant shares.
type GatewayOptions struct {
	Next Requester
	// Requests under this base URL are Prometheus queries: they get its
	// timeout and may be cached. Matched by URL, since Loki has the same
	// /api/v1/query_range suffix.
	PrometheusURL string
	MaxConcurrent int
	MaxQueued     int
	QueueWait     time.Duration
	// Successful Prometheus answers are reused this long; zero is off.
	CacheTTL time.Duration
	// Sent as Prometheus's timeout so it stops evaluating when we stop
	// waiting.
	PrometheusTimeout time.Duration
	// ok, cached, shared, busy or error.
	OnOutcome func(outcome string)
}

// Gateway caps backend requests in flight with a short bounded queue, shares
// identical requests in flight, and caches identical Prometheus queries.
type Gateway struct {
	opts   GatewayOptions
	slots  chan struct{}
	queue  chan struct{}
	flight singleflight.Group
	cache  *ttlcache.Cache[Response]
	prom   *url.URL
}

const maxCachedQueries = 1000

func NewGateway(opts GatewayOptions) *Gateway {
	g := &Gateway{
		opts:  opts,
		slots: make(chan struct{}, opts.MaxConcurrent),
		queue: make(chan struct{}, opts.MaxQueued),
		cache: ttlcache.New[Response](opts.CacheTTL, maxCachedQueries, nil),
	}
	if opts.PrometheusURL != "" {
		g.prom, _ = url.Parse(strings.TrimRight(opts.PrometheusURL, "/"))
	}
	if g.opts.OnOutcome == nil {
		g.opts.OnOutcome = func(string) {}
	}

	return g
}

func (g *Gateway) isPrometheusQuery(u *url.URL) bool {
	if g.prom == nil || u.Scheme != g.prom.Scheme || u.Host != g.prom.Host {
		return false
	}
	base := strings.TrimSuffix(g.prom.Path, "/")

	return u.Path == base+"/api/v1/query" || u.Path == base+"/api/v1/query_range"
}

func (g *Gateway) acquire(ctx context.Context) error {
	select {
	case g.slots <- struct{}{}:
		return nil
	default:
	}
	select {
	case g.queue <- struct{}{}:
	default:
		return &Refused{Reason: "busy", RetryAfterSeconds: 1, Message: fmt.Sprintf(
			"The observability backend is at its limit (%d running, %d waiting); retry shortly", g.opts.MaxConcurrent, g.opts.MaxQueued)}
	}
	defer func() { <-g.queue }()
	timer := time.NewTimer(g.opts.QueueWait)
	defer timer.Stop()
	select {
	case g.slots <- struct{}{}:
		return nil
	case <-timer.C:
		return &Refused{Reason: "busy", RetryAfterSeconds: 1, Message: fmt.Sprintf(
			"The observability backend stayed at its concurrent limit for %d ms; retry shortly", g.opts.QueueWait.Milliseconds())}
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (g *Gateway) Get(ctx context.Context, u *url.URL) (Response, error) {
	prometheus := g.isPrometheusQuery(u)
	if prometheus && g.opts.PrometheusTimeout > 0 && !u.Query().Has("timeout") {
		copied := *u
		q := copied.Query()
		q.Set("timeout", fmt.Sprintf("%ds", int(g.opts.PrometheusTimeout.Seconds())))
		copied.RawQuery = q.Encode()
		u = &copied
	}
	key := u.String()
	cacheable := prometheus && g.opts.CacheTTL > 0
	if cacheable {
		if hit, ok := g.cache.Get(key); ok {
			g.opts.OnOutcome("cached")

			return hit, nil
		}
	}

	// singleflight reports every caller as shared, the one that ran the
	// request included; only the joiners are shared outcomes.
	ran := false
	result, err, _ := g.flight.Do(key, func() (any, error) {
		ran = true
		// Detached from the first caller so its cancellation cannot fail
		// the others sharing the request.
		bg := context.WithoutCancel(ctx)
		if err := g.acquire(bg); err != nil {
			return Response{}, err
		}
		defer func() { <-g.slots }()

		return g.opts.Next.Get(bg, u)
	})
	shared := !ran
	if shared {
		g.opts.OnOutcome("shared")
	}
	if err != nil && !shared {
		var refused *Refused
		if errors.As(err, &refused) {
			g.opts.OnOutcome("busy")
		} else {
			g.opts.OnOutcome("error")
		}
	}
	if err != nil {
		return Response{}, err
	}
	resp := result.(Response)
	if cacheable && resp.Status == http.StatusOK {
		g.cache.Set(key, resp)
	}
	if !shared {
		g.opts.OnOutcome("ok")
	}

	return resp, nil
}
