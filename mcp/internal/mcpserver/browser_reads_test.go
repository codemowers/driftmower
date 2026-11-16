package mcpserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/observability"
	sdkauth "github.com/modelcontextprotocol/go-sdk/auth"
)

func TestBrowserMetricsGETPOSTShareAuthorizationAndQueries(t *testing.T) {
	var calls atomic.Int32
	o := &observability.Service{PrometheusURL: "http://prometheus", Alignment: 15 * time.Second, Judge: allowAll{}, Backend: observability.RequesterFunc(func(context.Context, *url.URL) (observability.Response, error) {
		calls.Add(1)
		return observability.Response{Status: 200, Body: []byte(`{"status":"success","data":{"resultType":"vector","result":[]}}`)}, nil
	})}
	h := sdkauth.RequireBearerToken(func(context.Context, string, *http.Request) (*sdkauth.TokenInfo, error) {
		return auth.NewTokenInfo(&auth.Caller{Sub: "alice", IdentityClaims: auth.IdentityClaims{Username: "alice"}}, nil, time.Now().Add(time.Hour)), nil
	}, nil)(BrowserReads(o, &Workloads{Judge: allowAll{}}, auth.Mapping{}))
	var bodies []string
	for _, method := range []string{"GET", "POST"} {
		path, body := "/api/observability/namespace-resources?namespace=team-a", ""
		if method == "POST" {
			path = "/api/observability/namespace-resources"
			body = `{"namespace":"team-a"}`
		}
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer valid")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("%s: %d %s", method, w.Code, w.Body)
		}
		if method == "GET" && !strings.Contains(w.Header().Get("Cache-Control"), "private") || method == "POST" && w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(w.Header())
		}
		bodies = append(bodies, w.Body.String())
	}
	if calls.Load() != 32 || bodies[0] != bodies[1] {
		t.Fatalf("queries %d; GET/POST differ", calls.Load())
	}
	// Permission decisions are still required before touching Prometheus.
	o.Judge = verdictJudge(func(authz.Attributes) authz.Verdict { return authz.No })
	r := httptest.NewRequest("GET", "/api/observability/namespace-resources?namespace=team-b", nil)
	r.Header.Set("Authorization", "Bearer valid")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code == 200 || w.Header().Get("Cache-Control") != "no-store" || calls.Load() != 32 {
		t.Fatalf("denied request: %d queries=%d", w.Code, calls.Load())
	}
}

func TestHistoryBrowserReadsUseDedicatedPrometheusAndPrivateGETCaching(t *testing.T) {
	var calls atomic.Int32
	history := &observability.Service{PrometheusURL: "http://history", Judge: allowAll{}, Alignment: 5 * time.Minute, Backend: observability.RequesterFunc(func(_ context.Context, u *url.URL) (observability.Response, error) {
		calls.Add(1)
		if u.Host != "history" || !strings.Contains(u.Query().Get("query"), "driftmower_image_created_timestamp_seconds") {
			t.Errorf("unexpected backend %s", u)
		}
		return observability.Response{Status: 200, Body: []byte(`{"status":"success","data":{"resultType":"matrix","result":[]}}`)}, nil
	})}
	h := sdkauth.RequireBearerToken(func(context.Context, string, *http.Request) (*sdkauth.TokenInfo, error) {
		return auth.NewTokenInfo(&auth.Caller{Sub: "alice", IdentityClaims: auth.IdentityClaims{Username: "alice"}}, nil, time.Now().Add(time.Hour)), nil
	}, nil)(BrowserReads(nil, nil, auth.Mapping{}, history))
	for _, method := range []string{"GET", "POST"} {
		path, body := "/api/observability/signal-history?signal=technical_debt&namespaces=team&hoursPerUpgrade=2&buildAgeDaysPerUpgrade=365", ""
		if method == "POST" {
			path = "/api/observability/signal-history"
			body = `{"signal":"technical_debt","namespaces":["team"],"hoursPerUpgrade":2,"buildAgeDaysPerUpgrade":365}`
		}
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer valid")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("%s: %d %s", method, w.Code, w.Body)
		}
		if method == "GET" && !strings.Contains(w.Header().Get("Cache-Control"), "private") || method == "POST" && w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(w.Header())
		}
	}
	if calls.Load() != 2 {
		t.Fatalf("queries %d", calls.Load())
	}
}
