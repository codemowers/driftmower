package metrics

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestInstrument(t *testing.T) {
	m := New()
	h := m.Instrument(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/missing" {
			http.NotFound(w, r)

			return
		}
		_, _ = w.Write([]byte("hello"))
	}))

	for _, req := range []*http.Request{
		httptest.NewRequest("POST", "/mcp", strings.NewReader("{}")),
		httptest.NewRequest("GET", "/ui/workloads/default", nil),
		httptest.NewRequest("PATCH", "/missing", nil),
		httptest.NewRequest("HEAD", "/", nil),
	} {
		h.ServeHTTP(httptest.NewRecorder(), req)
	}

	expected := `
# HELP driftmower_http_requests_total Completed or aborted HTTP requests.
# TYPE driftmower_http_requests_total counter
driftmower_http_requests_total{method="GET",outcome="complete",route="/ui",status="200"} 1
driftmower_http_requests_total{method="HEAD",outcome="complete",route="/",status="200"} 1
driftmower_http_requests_total{method="POST",outcome="complete",route="/mcp",status="200"} 1
driftmower_http_requests_total{method="other",outcome="complete",route="other",status="404"} 1
`
	if err := testutil.CollectAndCompare(m.requests, strings.NewReader(expected)); err != nil {
		t.Error(err)
	}
	if got := testutil.ToFloat64(m.inFlight); got != 0 {
		t.Errorf("in flight = %v", got)
	}
	if n := testutil.CollectAndCount(m.requestSize); n != 1 {
		t.Errorf("request size series = %d", n)
	}
}
