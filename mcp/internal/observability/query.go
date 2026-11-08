package observability

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/codemowers/driftmower/mcp/internal/authz"
)

type MetricsInput struct {
	Namespace string            `json:"namespace"`
	Metric    string            `json:"metric"`
	Labels    map[string]string `json:"labels,omitempty"`
	// raw, rate or increase.
	Operation     string   `json:"operation,omitempty"`
	WindowSeconds int      `json:"windowSeconds,omitempty"`
	Aggregate     string   `json:"aggregate,omitempty"`
	GroupBy       []string `json:"groupBy,omitempty"`
	Start         string   `json:"start,omitempty"`
	End           string   `json:"end,omitempty"`
	StepSeconds   int      `json:"stepSeconds,omitempty"`
	Limit         int      `json:"limit,omitempty"`
}

type MetricsResult struct {
	Source     string       `json:"source"`
	Namespace  string       `json:"namespace"`
	Query      string       `json:"query"`
	ResultType string       `json:"resultType"`
	Result     []promSeries `json:"result"`
	Warnings   []string     `json:"warnings"`
	Infos      []string     `json:"infos"`
}

// QueryMetrics answers a named metric with exact label filters, never
// arbitrary PromQL, confined to one namespace the caller may list pods in.
func (s *Service) QueryMetrics(ctx context.Context, id authz.Identity, in MetricsInput) (*MetricsResult, error) {
	if s.PrometheusURL == "" {
		return nil, errors.New("PROMETHEUS_URL is not configured")
	}
	if err := in.normalise(); err != nil {
		return nil, err
	}
	if _, ok := in.Labels["namespace"]; ok {
		return nil, errors.New("namespace and __name__ cannot be supplied as label filters")
	}
	if _, ok := in.Labels["__name__"]; ok {
		return nil, errors.New("namespace and __name__ cannot be supplied as label filters")
	}
	if len(in.Labels) > 20 {
		return nil, errors.New("at most 20 label filters are allowed")
	}
	if (in.Start == "") != (in.End == "") {
		return nil, errors.New("range queries require both start and end")
	}
	if len(in.GroupBy) > 0 && in.Aggregate == "" {
		return nil, errors.New("groupBy requires aggregate")
	}
	var start, end time.Time
	if in.Start != "" {
		var err error
		if start, err = time.Parse(time.RFC3339, in.Start); err != nil {
			return nil, fmt.Errorf("start: %w", err)
		}
		if end, err = time.Parse(time.RFC3339, in.End); err != nil {
			return nil, fmt.Errorf("end: %w", err)
		}
		maxRange := s.MaxHistoryRange
		if maxRange == 0 {
			maxRange = 7 * 24 * time.Hour
		}
		if !end.After(start) || end.Sub(start) > maxRange {
			return nil, errors.New("time range exceeds configured history limit")
		}
		if end.Sub(start).Seconds()/float64(in.StepSeconds) > 11000 {
			return nil, errors.New("too many range samples; increase stepSeconds")
		}
	}

	var result *MetricsResult
	err := s.admit(id, func(backend Requester) error {
		if err := s.require(ctx, id, authz.Attributes{Namespace: in.Namespace, Resource: "pods", Verb: "list"},
			"Kubernetes RBAC denied list pods in namespace "+in.Namespace); err != nil {
			return err
		}
		matchers := []string{"namespace=" + promString(in.Namespace)}
		for _, k := range slices.Sorted(maps.Keys(in.Labels)) {
			matchers = append(matchers, k+"="+promString(in.Labels[k]))
		}
		query := in.Metric + "{" + strings.Join(matchers, ",") + "}"
		if in.Operation != "" && in.Operation != "raw" {
			query = fmt.Sprintf("%s(%s[%ds])", in.Operation, query, in.WindowSeconds)
		}
		if in.Aggregate != "" {
			// Keep namespace in every result, including aggregates.
			groups := []string{"namespace"}
			for _, g := range in.GroupBy {
				if !slices.Contains(groups, g) {
					groups = append(groups, g)
				}
			}
			query = fmt.Sprintf("%s by (%s) (%s)", in.Aggregate, strings.Join(groups, ","), query)
		}

		path := "/api/v1/query"
		if in.Start != "" {
			path = "/api/v1/query_range"
		}
		u := endpoint(s.PrometheusURL, path)
		q := u.Query()
		q.Set("query", query)
		q.Set("limit", strconv.Itoa(in.Limit))
		if in.Start != "" {
			q.Set("start", in.Start)
			q.Set("end", in.End)
			q.Set("step", strconv.Itoa(in.StepSeconds))
		}
		u.RawQuery = q.Encode()

		var resp promResponse
		if err := get(ctx, backend, u, "Prometheus", &resp); err != nil {
			return err
		}
		if err := resp.check(""); err != nil {
			return err
		}
		for _, series := range resp.Data.Result {
			if series.Metric["namespace"] != in.Namespace {
				return errors.New("Prometheus returned a result outside the requested namespace") //nolint:staticcheck // Prometheus is a proper noun.
			}
		}
		series := resp.Data.Result
		if len(series) > in.Limit {
			series = series[:in.Limit]
		}
		result = &MetricsResult{Source: "prometheus", Namespace: in.Namespace, Query: query, ResultType: resp.Data.ResultType,
			Result: orEmpty(series), Warnings: orEmpty(resp.Warnings), Infos: orEmpty(resp.Infos)}

		return nil
	})

	return result, err
}

var (
	namespacePattern  = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)
	metricNamePattern = regexp.MustCompile(`^[a-zA-Z_:][a-zA-Z0-9_:]*$`)
	labelNamePattern  = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)
)

// normalise applies defaults and rejects input that would be spliced into
// PromQL unquoted: the metric name, label names and groupBy labels.
func (in *MetricsInput) normalise() error {
	if in.Operation == "" {
		in.Operation = "raw"
	}
	if in.WindowSeconds == 0 {
		in.WindowSeconds = 300
	}
	if in.StepSeconds == 0 {
		in.StepSeconds = 60
	}
	if in.Limit == 0 {
		in.Limit = 100
	}
	switch {
	case len(in.Namespace) > 63 || !namespacePattern.MatchString(in.Namespace):
		return errors.New("namespace must be a DNS label")
	case len(in.Metric) > 256 || !metricNamePattern.MatchString(in.Metric):
		return errors.New("metric must be a Prometheus metric name")
	case !slices.Contains([]string{"raw", "rate", "increase"}, in.Operation):
		return errors.New("operation must be raw, rate or increase")
	case in.Aggregate != "" && !slices.Contains([]string{"sum", "avg", "min", "max", "count"}, in.Aggregate):
		return errors.New("aggregate must be sum, avg, min, max or count")
	case in.WindowSeconds < 60 || in.WindowSeconds > 86400:
		return errors.New("windowSeconds must be between 60 and 86400")
	case in.StepSeconds < 15 || in.StepSeconds > 86400:
		return errors.New("stepSeconds must be between 15 and 86400")
	case in.Limit < 1 || in.Limit > 1000:
		return errors.New("limit must be between 1 and 1000")
	case len(in.GroupBy) > 10:
		return errors.New("at most 10 groupBy labels are allowed")
	}
	for k, v := range in.Labels {
		if len(k) > 128 || !labelNamePattern.MatchString(k) || len(v) > 1024 {
			return fmt.Errorf("invalid label filter %q", k)
		}
	}
	for _, g := range in.GroupBy {
		if len(g) > 128 || !labelNamePattern.MatchString(g) {
			return fmt.Errorf("invalid groupBy label %q", g)
		}
	}

	return nil
}

func orEmpty[T any](items []T) []T {
	if items == nil {
		return []T{}
	}

	return items
}

type LogsInput struct {
	Namespace string `json:"namespace"`
	Pod       string `json:"pod"`
	Container string `json:"container,omitempty"`
	Contains  string `json:"contains,omitempty"`
	Start     string `json:"start,omitempty"`
	End       string `json:"end,omitempty"`
	Limit     int    `json:"limit,omitempty"`
}

type LogEntry struct {
	Timestamp string `json:"timestamp"`
	Line      string `json:"line"`
}

type LokiStream struct {
	Stream map[string]string `json:"stream"`
	Values [][]any           `json:"values"`
}

type LogsResult struct {
	// loki or kubernetes.
	Source    string       `json:"source"`
	Namespace string       `json:"namespace"`
	Pod       string       `json:"pod"`
	Container *string      `json:"container,omitempty"`
	Query     string       `json:"query,omitempty"`
	Streams   []LokiStream `json:"streams,omitempty"`
	Entries   []LogEntry   `json:"entries,omitempty"`
	Warnings  []string     `json:"warnings"`
}

// QueryLogs reads one pod's logs from Loki when configured, otherwise the
// retained logs of its current container from Kubernetes. A failing Loki is
// not permission to switch sources.
func (s *Service) QueryLogs(ctx context.Context, id authz.Identity, in LogsInput) (*LogsResult, error) {
	if in.Limit == 0 {
		in.Limit = 100
	}
	end := s.now()
	if in.End != "" {
		var err error
		if end, err = time.Parse(time.RFC3339, in.End); err != nil {
			return nil, fmt.Errorf("end: %w", err)
		}
	}
	start := end.Add(-time.Hour)
	if in.Start != "" {
		var err error
		if start, err = time.Parse(time.RFC3339, in.Start); err != nil {
			return nil, fmt.Errorf("start: %w", err)
		}
	}
	if err := validateRange(start, end); err != nil {
		return nil, err
	}

	var result *LogsResult
	err := s.admit(id, func(backend Requester) error {
		if err := s.require(ctx, id, authz.Attributes{Namespace: in.Namespace, Resource: "pods", Subresource: "log", Verb: "get", Name: in.Pod},
			"Kubernetes RBAC denied get pods/log in namespace "+in.Namespace); err != nil {
			return err
		}
		var err error
		if s.LokiURL != "" {
			result, err = s.lokiLogs(ctx, backend, in, start, end)
		} else {
			result, err = s.kubernetesLogs(ctx, in, start, end)
		}

		return err
	})

	return result, err
}

func (s *Service) lokiLogs(ctx context.Context, backend Requester, in LogsInput, start, end time.Time) (*LogsResult, error) {
	matchers := map[string]string{"namespace": in.Namespace, "pod": in.Pod}
	parts := []string{"namespace=" + promString(in.Namespace), "pod=" + promString(in.Pod)}
	if in.Container != "" {
		matchers["container"] = in.Container
		parts = append(parts, "container="+promString(in.Container))
	}
	query := "{" + strings.Join(parts, ",") + "}"
	if in.Contains != "" {
		query += " |= " + promString(in.Contains)
	}
	u := endpoint(s.LokiURL, "/loki/api/v1/query_range")
	q := u.Query()
	q.Set("query", query)
	q.Set("start", strconv.FormatInt(start.UnixNano(), 10))
	q.Set("end", strconv.FormatInt(end.UnixNano(), 10))
	q.Set("limit", strconv.Itoa(in.Limit))
	q.Set("direction", "backward")
	u.RawQuery = q.Encode()

	var resp struct {
		Status string `json:"status"`
		Data   struct {
			ResultType string       `json:"resultType"`
			Result     []LokiStream `json:"result"`
		} `json:"data"`
	}
	if err := get(ctx, backend, u, "Loki", &resp); err != nil {
		return nil, err
	}
	if resp.Status != "success" || resp.Data.ResultType != "streams" {
		return nil, errors.New("Loki returned an unexpected response") //nolint:staticcheck // Loki is a proper noun.
	}
	for _, stream := range resp.Data.Result {
		for k, v := range matchers {
			if stream.Stream[k] != v {
				return nil, errors.New("Loki returned a stream outside the requested scope") //nolint:staticcheck // Loki is a proper noun.
			}
		}
	}

	return &LogsResult{Source: "loki", Namespace: in.Namespace, Pod: in.Pod, Query: query, Streams: orEmpty(resp.Data.Result), Warnings: []string{}}, nil
}

func (s *Service) kubernetesLogs(ctx context.Context, in LogsInput, start, end time.Time) (*LogsResult, error) {
	since := metav1.NewTime(start)
	tail, limitBytes := int64(in.Limit), int64(1<<20)
	raw, err := s.Kubernetes.CoreV1().Pods(in.Namespace).GetLogs(in.Pod, &corev1.PodLogOptions{
		Container: in.Container, Timestamps: true, SinceTime: &since, TailLines: &tail, LimitBytes: &limitBytes,
	}).DoRaw(ctx)
	if err != nil {
		return nil, err
	}

	var entries []LogEntry
	for line := range strings.SplitSeq(string(raw), "\n") {
		stamp, text, ok := strings.Cut(line, " ")
		if !ok {
			continue
		}
		t, err := time.Parse(time.RFC3339Nano, stamp)
		if err != nil || t.Before(start) || t.After(end) || (in.Contains != "" && !strings.Contains(text, in.Contains)) {
			continue
		}
		entries = append(entries, LogEntry{Timestamp: stamp, Line: text})
	}
	if len(entries) > in.Limit {
		entries = entries[len(entries)-in.Limit:]
	}
	slices.Reverse(entries)
	result := &LogsResult{Source: "kubernetes", Namespace: in.Namespace, Pod: in.Pod, Entries: orEmpty(entries), Warnings: []string{
		"Kubernetes returns only retained logs from the current container instance. Results are limited to the latest requested lines and 1 MiB before time/text filtering; " +
			"archived or deleted pod logs are unavailable. Specify container for multi-container pods.",
	}}
	if in.Container != "" {
		result.Container = &in.Container
	}

	return result, nil
}
