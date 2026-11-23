// Package metrics holds the application's Prometheus collectors on a dedicated
// registry, so only these series are exported.
package metrics

import (
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var routes = map[string]bool{
	"/":                                     true,
	"/mcp":                                  true,
	"/.well-known/oauth-protected-resource": true,
	"/.well-known/oauth-protected-resource/mcp":      true,
	"/api/provisioning/capabilities":                 true,
	"/api/cache/invalidate":                          true,
	"/api/crawler/authorize":                         true,
	"/api/observability/cluster-health":              true,
	"/api/observability/alerts":                      true,
	"/api/observability/namespace-resources":         true,
	"/api/observability/workload-resources":          true,
	"/api/observability/log-rate":                    true,
	"/api/observability/signal-history":              true,
	"/api/observability/signal-history-capabilities": true,
	"/api/observability/image-scan-statuses":         true,
}

var methods = map[string]bool{
	http.MethodGet: true, http.MethodHead: true, http.MethodPost: true,
	http.MethodDelete: true, http.MethodOptions: true,
}

var sizeBuckets = []float64{128, 1024, 16384, 262144, 1048576}

type Metrics struct {
	Registry *prometheus.Registry

	Sessions           prometheus.Counter
	OpenSessions       prometheus.Gauge
	Invalidations      *prometheus.CounterVec
	ObservabilityGuard *prometheus.CounterVec
	ToolResponseSize   *prometheus.HistogramVec
	ToolDuration       *prometheus.HistogramVec

	requests     *prometheus.CounterVec
	inFlight     prometheus.Gauge
	latency      *prometheus.HistogramVec
	requestSize  prometheus.Histogram
	responseSize prometheus.Histogram
}

func New() *Metrics {
	m := &Metrics{
		Registry:         prometheus.NewRegistry(),
		ToolResponseSize: prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "driftmower_mcp_tool_response_size_bytes", Help: "Serialized MCP tool result JSON bytes, excluding JSON-RPC/SSE framing and compression. Unknown tools use other.", Buckets: []float64{128, 1024, 4096, 16384, 65536, 262144, 1 << 20, 4 << 20, 16 << 20, 64 << 20}}, []string{"tool", "outcome"}),
		ToolDuration:     prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "driftmower_mcp_tool_duration_seconds", Help: "Server-side MCP tool call duration including handler and output validation, excluding response transport. Unknown/protocol-error calls use other.", Buckets: []float64{0.005, 0.025, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60}}, []string{"tool", "outcome"}),
		Sessions: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "driftmower_mcp_sessions_total",
			Help: "MCP sessions initialized.",
		}),
		OpenSessions: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "driftmower_mcp_sessions_open",
			Help: "MCP sessions held in memory, until closed by the client or evicted as idle.",
		}),
		Invalidations: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "driftmower_mcp_sar_cache_invalidations_total",
			Help: "SubjectAccessReview cache invalidations by source.",
		}, []string{"source"}),
		ObservabilityGuard: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "driftmower_mcp_observability_guard_total",
			Help: "Observability backend requests by outcome (ok, shared, error).",
		}, []string{"outcome"}),
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "driftmower_http_requests_total",
			Help: "Completed or aborted HTTP requests.",
		}, []string{"route", "method", "status", "outcome"}),
		inFlight: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "driftmower_http_requests_in_flight",
			Help: "HTTP requests and streams still open.",
		}),
		latency: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "driftmower_http_request_duration_seconds",
			Help:    "Time until the HTTP response completes or aborts, including stream lifetime.",
			Buckets: []float64{0.005, 0.025, 0.1, 0.5, 1, 5, 15, 60},
		}, []string{"route", "method"}),
		requestSize: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "driftmower_http_declared_request_size_bytes",
			Help:    "Request body size when a valid Content-Length is supplied; chunked requests are omitted.",
			Buckets: sizeBuckets,
		}),
		responseSize: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "driftmower_http_response_size_bytes",
			Help:    "Response body bytes written by the application before completion or abort.",
			Buckets: sizeBuckets,
		}),
	}
	m.Registry.MustRegister(
		collectors.NewGoCollector(collectors.WithGoCollectorRuntimeMetrics(collectors.MetricsGC, collectors.MetricsMemory)),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		m.Sessions, m.OpenSessions, m.Invalidations, m.ObservabilityGuard,
		m.ToolResponseSize, m.ToolDuration,
		m.requests, m.inFlight, m.latency, m.requestSize, m.responseSize,
	)

	return m
}

func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.Registry, promhttp.HandlerOpts{})
}

func routeLabel(path string) string {
	switch {
	case routes[path]:
		return path
	default:
		return "other"
	}
}

// Instrument records request counts, latency and sizes for next. Unknown
// routes and methods share the label "other" to bound cardinality.
func (m *Metrics) Instrument(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		route := routeLabel(r.URL.Path)
		method := r.Method
		if !methods[method] {
			method = "other"
		}
		if r.ContentLength >= 0 && r.Header.Get("Content-Length") != "" {
			m.requestSize.Observe(float64(r.ContentLength))
		}

		m.inFlight.Inc()
		rec := &recorder{ResponseWriter: w, status: http.StatusOK, head: r.Method == http.MethodHead}
		start := time.Now()
		outcome := "aborted"
		defer func() {
			m.inFlight.Dec()
			if r.Context().Err() == nil {
				outcome = "complete"
			}
			m.requests.WithLabelValues(route, method, strconv.Itoa(rec.status), outcome).Inc()
			m.latency.WithLabelValues(route, method).Observe(time.Since(start).Seconds())
			m.responseSize.Observe(float64(rec.bytes))
		}()

		next.ServeHTTP(rec, r)
	})
}

type recorder struct {
	http.ResponseWriter
	status      int
	bytes       int
	head        bool
	wroteHeader bool
}

func (r *recorder) WriteHeader(status int) {
	if !r.wroteHeader {
		r.status = status
		r.wroteHeader = true
	}
	r.ResponseWriter.WriteHeader(status)
}

func (r *recorder) Write(b []byte) (int, error) {
	r.wroteHeader = true
	n, err := r.ResponseWriter.Write(b)
	if !r.head && r.status != http.StatusNoContent && r.status != http.StatusNotModified {
		r.bytes += n
	}

	return n, err
}

// Flush forwards to the underlying writer so streamed responses are sent
// promptly.
func (r *recorder) Flush() {
	_ = http.NewResponseController(r.ResponseWriter).Flush()
}

// Unwrap lets http.ResponseController reach the underlying writer's other
// capabilities, such as deadlines.
func (r *recorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}
