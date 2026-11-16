// Package observability answers metrics, logs, resource-usage and volume
// questions from Prometheus, Loki and the Kubernetes API.
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
		defer func() { _ = resp.Body.Close() }()
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

// GatewayOptions configure query sharing and backend timeouts.
type GatewayOptions struct {
	Next Requester
	// Requests under this base URL are Prometheus queries: they get its
	// timeout. Matched by URL, since Loki has the same
	// /api/v1/query_range suffix.
	PrometheusURL string
	// Sent as Prometheus's timeout so it stops evaluating when we stop
	// waiting.
	PrometheusTimeout time.Duration
	// ok, shared or error.
	OnOutcome func(outcome string)
}

// Gateway shares identical requests in flight. Completed responses are never retained.
type Gateway struct {
	opts   GatewayOptions
	flight singleflight.Group
	prom   *url.URL
}

func NewGateway(opts GatewayOptions) *Gateway {
	g := &Gateway{opts: opts}
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
	// singleflight reports every caller as shared, the one that ran the
	// request included; only the joiners are shared outcomes.
	ran := false
	result, err, _ := g.flight.Do(key, func() (any, error) {
		ran = true
		// Detached from the first caller so its cancellation cannot fail
		// the others sharing the request.
		bg := context.WithoutCancel(ctx)

		return g.opts.Next.Get(bg, u)
	})
	shared := !ran
	if shared {
		g.opts.OnOutcome("shared")
	}
	if err != nil && !shared {
		g.opts.OnOutcome("error")
	}
	if err != nil {
		return Response{}, err
	}
	resp := result.(Response)
	if !shared {
		g.opts.OnOutcome("ok")
	}

	return resp, nil
}
