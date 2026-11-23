package observability

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/nonnil"
)

var DriftMetrics = []string{
	"driftmower_version_releases_behind",
	"driftmower_version_status",
	"driftmower_image_created_timestamp_seconds",
	"driftmower_version_checked_timestamp_seconds",
	"driftmower_version_container_count",
}

type DriftHistoryInput struct {
	Points     int      `json:"points,omitempty" jsonschema:"Target samples per series; default 400, 20 to 1000. Responses adapt resolution to stay bounded."`
	Workload   string   `json:"workload,omitempty"`
	Kind       string   `json:"kind,omitempty"`
	Image      string   `json:"image,omitempty"`
	Metrics    []string `json:"metrics,omitempty" jsonschema:"Drift metrics to return; all when omitted"`
	Namespaces []string `json:"namespaces,omitempty" jsonschema:"Namespace scope; omitted requires cluster-wide list pods"`
	Days       int      `json:"days,omitempty" jsonschema:"History window in days; default 90"`
}

type DriftHistory struct {
	Start       int64                   `json:"start"`
	End         int64                   `json:"end"`
	StepSeconds int                     `json:"stepSeconds"`
	Metrics     map[string][]promSeries `json:"metrics"`
	Warnings    []string                `json:"warnings"`
}

// maxDriftSeries bounds one metric's response across the whole scope.
const maxDriftSeries = 50000

// DriftHistory scopes detail reads and uses one shared sample resolution.
// Oversized upstream responses retry all metrics together at a coarser step.
func (s *Service) DriftHistory(ctx context.Context, id authz.Identity, in DriftHistoryInput) (*DriftHistory, error) {
	if s.PrometheusURL == "" {
		return nil, errors.New("history Prometheus is not configured")
	}
	if len(in.Metrics) == 0 {
		in.Metrics = DriftMetrics
	}
	for _, m := range in.Metrics {
		if !slices.Contains(DriftMetrics, m) {
			return nil, errors.New("unsupported drift metric " + m)
		}
	}
	if in.Days == 0 {
		in.Days = 90
	}
	if in.Days < 1 || in.Days > 90 {
		return nil, errors.New("days must be 1 to 90")
	}
	namespaces := slices.Clone(in.Namespaces)
	slices.Sort(namespaces)
	namespaces = slices.Compact(namespaces)
	selector := ""
	if len(namespaces) > 0 {
		parts := make([]string, len(namespaces))
		for i, ns := range namespaces {
			if !namespacePattern.MatchString(ns) {
				return nil, errors.New("invalid namespace " + ns)
			}
			parts[i] = regexp.QuoteMeta(ns)
		}
		selector = "namespace=~" + promString(strings.Join(parts, "|"))
	}
	if in.Points == 0 {
		in.Points = 400
	}
	if in.Points < 20 || in.Points > 1000 || len(in.Workload) > 253 || len(in.Kind) > 128 || len(in.Image) > 1024 {
		return nil, errors.New("invalid history resolution or item scope")
	}
	extra := []string{}
	if selector != "" {
		extra = append(extra, selector)
	}
	if in.Workload != "" {
		extra = append(extra, "workload="+promString(in.Workload))
	}
	if in.Kind != "" {
		extra = append(extra, "kind="+promString(in.Kind))
	}
	if in.Image != "" {
		aliases := []string{regexp.QuoteMeta(in.Image)}
		if image, ok := strings.CutPrefix(in.Image, "docker.io/"); ok {
			aliases = append(aliases, regexp.QuoteMeta(image))
			if official, ok := strings.CutPrefix(image, "library/"); ok {
				aliases = append(aliases, regexp.QuoteMeta(official))
			}
		}
		extra = append(extra, "image=~"+promString("("+strings.Join(aliases, "|")+")([:@].*)?"))
	}
	selector = strings.Join(extra, ",")
	steps := []int{900, 1800, 3600, 7200, 10800, 14400, 21600, 28800, 43200, 86400}
	resolution := 0
	for resolution < len(steps)-1 && in.Days*86400/steps[resolution] > in.Points {
		resolution++
	}
	step := steps[resolution]
	end := s.now().Truncate(5 * time.Minute)
	start := end.Add(-time.Duration(in.Days) * 24 * time.Hour)
	out := &DriftHistory{Start: start.Unix(), End: end.Unix(), StepSeconds: step, Metrics: map[string][]promSeries{}, Warnings: []string{}}
	scopes := namespaces
	if len(scopes) == 0 {
		scopes = []string{""}
	}
	for _, ns := range scopes {
		if err := s.require(ctx, id, authz.Attributes{Namespace: ns, Resource: "pods", Verb: "list"}, "Kubernetes RBAC denied reading drift history in the requested scope"); err != nil {
			return nil, err
		}
	}
retry:
	for {
		step = steps[resolution]
		out.StepSeconds = step
		out.Metrics = map[string][]promSeries{}
		out.Warnings = []string{}
		for _, metric := range in.Metrics {
			u := endpoint(s.PrometheusURL, "/api/v1/query_range")
			q := u.Query()
			labels := "namespace,uid,kind,workload,image,version,latest"
			if metric == "driftmower_version_status" {
				labels += ",status,reason"
			}
			q.Set("query", fmt.Sprintf("max by (%s) (%s{%s})", labels, metric, selector))
			q.Set("start", strconv.FormatInt(start.Unix(), 10))
			q.Set("end", strconv.FormatInt(end.Unix(), 10))
			q.Set("step", strconv.Itoa(step))
			q.Set("limit", strconv.Itoa(maxDriftSeries+1))
			u.RawQuery = q.Encode()
			var resp promResponse
			if err := get(ctx, s.Backend, u, "Prometheus drift history", &resp); err != nil {
				if errors.Is(err, ErrResponseTooLarge) && resolution < len(steps)-1 {
					resolution++
					continue retry
				}
				return nil, err
			}
			if err := resp.check("matrix"); err != nil {
				return nil, err
			}
			if len(resp.Data.Result) > maxDriftSeries {
				return nil, errors.New("drift history exceeded the series limit; narrow namespaces")
			}
			for _, series := range resp.Data.Result {
				if len(namespaces) > 0 && !slices.Contains(namespaces, series.Metric["namespace"]) {
					return nil, errors.New("Prometheus returned a result outside the requested namespaces") //nolint:staticcheck // Prometheus is a proper noun.
				}
			}
			out.Metrics[metric] = nonnil.Slice(resp.Data.Result)
			out.Warnings = append(out.Warnings, resp.Warnings...)
		}
		return out, nil
	}
}
