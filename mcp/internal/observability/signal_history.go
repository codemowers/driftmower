package observability

import (
	"context"
	"errors"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/codemowers/driftmower/mcp/internal/authz"
)

type SignalHistoryInput struct {
	Signal                 string   `json:"signal" jsonschema:"cves, serviceaccounts, or technical_debt"`
	Namespaces             []string `json:"namespaces,omitempty" jsonschema:"Namespace scope; omitted requires cluster-wide list pods"`
	Days                   int      `json:"days,omitempty"`
	HoursPerUpgrade        float64  `json:"hoursPerUpgrade,omitempty"`
	BuildAgeDaysPerUpgrade float64  `json:"buildAgeDaysPerUpgrade,omitempty"`
}
type SignalSeries struct {
	Name   string       `json:"name"`
	Values [][2]float64 `json:"values"`
}
type SignalHistory struct {
	Signal      string         `json:"signal"`
	Query       string         `json:"query"`
	Start       int64          `json:"start"`
	End         int64          `json:"end"`
	StepSeconds int            `json:"stepSeconds"`
	Series      []SignalSeries `json:"series"`
	Warnings    []string       `json:"warnings"`
}

type SignalHistoryFeatures struct {
	CVEs            bool `json:"cves"`
	ServiceAccounts bool `json:"serviceaccounts"`
	TechnicalDebt   bool `json:"technical_debt"`
}

func (s *Service) SignalHistoryFeatures() SignalHistoryFeatures {
	return SignalHistoryFeatures{CVEs: s.MetricsEnabled() && s.CVEHistoryEnabled, ServiceAccounts: s.MetricsEnabled() && s.SAHistoryEnabled, TechnicalDebt: s.MetricsEnabled()}
}

// SignalHistory evaluates bounded, caller-scoped PromQL over retained facts.
// Effort estimates are never stored: changing assumptions recalculates history.
func (s *Service) SignalHistory(ctx context.Context, id authz.Identity, in SignalHistoryInput) (*SignalHistory, error) {
	if s.PrometheusURL == "" {
		return nil, errors.New("history Prometheus is not configured")
	}
	if in.Signal == "cves" && !s.CVEHistoryEnabled || in.Signal == "serviceaccounts" && !s.SAHistoryEnabled {
		return nil, errors.New("historical signal is disabled by configuration")
	}
	if in.Days == 0 {
		in.Days = 90
	}
	if in.HoursPerUpgrade == 0 {
		in.HoursPerUpgrade = 1
	}
	if in.BuildAgeDaysPerUpgrade == 0 {
		in.BuildAgeDaysPerUpgrade = 365
	}
	if in.Days < 1 || in.Days > 90 || len(in.Namespaces) > 500 || math.IsNaN(in.HoursPerUpgrade) || math.IsInf(in.HoursPerUpgrade, 0) || in.HoursPerUpgrade <= 0 || in.HoursPerUpgrade > 10000 || math.IsNaN(in.BuildAgeDaysPerUpgrade) || math.IsInf(in.BuildAgeDaysPerUpgrade, 0) || in.BuildAgeDaysPerUpgrade < 1 || in.BuildAgeDaysPerUpgrade > 36500 {
		return nil, errors.New("invalid history window, namespace count or effort assumptions")
	}
	namespaces := slices.Clone(in.Namespaces)
	slices.Sort(namespaces)
	namespaces = slices.Compact(namespaces)
	for _, ns := range namespaces {
		if ns == "" {
			return nil, errors.New("namespace must not be empty")
		}
	}
	selector := ""
	if len(namespaces) > 0 {
		parts := make([]string, len(namespaces))
		for i, ns := range namespaces {
			parts[i] = regexp.QuoteMeta(ns)
		}
		selector = "namespace=~" + promString(strings.Join(parts, "|"))
	}
	query, err := signalExpression(in, selector)
	if err != nil {
		return nil, err
	}
	step := 300
	if in.Days > 7 {
		step = 3600
	}
	end := s.now().Truncate(5 * time.Minute)
	start := end.Add(-time.Duration(in.Days) * 24 * time.Hour)
	out := &SignalHistory{Signal: in.Signal, Query: query, Start: start.Unix(), End: end.Unix(), StepSeconds: step, Series: []SignalSeries{}, Warnings: []string{}}
	err = func(backend Requester) error {
		scopes := namespaces
		if len(scopes) == 0 {
			scopes = []string{""}
		}
		for _, ns := range scopes {
			if err := s.require(ctx, id, authz.Attributes{Namespace: ns, Resource: "pods", Verb: "list"}, "Kubernetes RBAC denied reading historical signals in the requested scope"); err != nil {
				return err
			}
		}
		u := endpoint(s.PrometheusURL, "/api/v1/query_range")
		q := u.Query()
		q.Set("query", query)
		q.Set("start", strconv.FormatInt(start.Unix(), 10))
		q.Set("end", strconv.FormatInt(end.Unix(), 10))
		q.Set("step", strconv.Itoa(step))
		q.Set("limit", "9")
		u.RawQuery = q.Encode()
		var response promResponse
		if err := get(ctx, backend, u, "Prometheus signal history", &response); err != nil {
			return err
		}
		if err := response.check("matrix"); err != nil {
			return err
		}
		if len(response.Data.Result) > 8 {
			return errors.New("signal history exceeded the series limit")
		}
		out.Warnings = append(out.Warnings, response.Warnings...)
		seen := map[string]bool{}
		for _, series := range response.Data.Result {
			name := series.Metric["signal"]
			if !slices.Contains(signalNames[in.Signal], name) || seen[name] || len(series.Metric) != 1 {
				return errors.New("Prometheus returned unexpected signal labels")
			}
			seen[name] = true
			row := SignalSeries{Name: name, Values: [][2]float64{}}
			if len(series.Values) > 11000 {
				return errors.New("signal history exceeded the sample limit")
			}
			for _, sample := range series.Values {
				value, err := strconv.ParseFloat(sample.Value, 64)
				if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || sample.Time < float64(start.Unix()) || sample.Time > float64(end.Unix()) {
					return errors.New("invalid signal sample")
				}
				row.Values = append(row.Values, [2]float64{sample.Time, value})
			}
			out.Series = append(out.Series, row)
		}
		return nil
	}(s.Backend)
	return out, err
}

var signalNames = map[string][]string{
	"cves":            {"critical", "high", "unscanned_images", "unresolved_containers"},
	"serviceaccounts": {"cluster_admin", "broad_permissions"},
	"technical_debt":  {"hours", "version_backlog", "build_age_fallback", "unknown"},
}

func signalExpression(in SignalHistoryInput, selector string) (string, error) {
	metric := func(name string) string { return name + "{" + selector + "}" }
	label := func(expression, name string) string {
		return fmt.Sprintf(`label_replace((%s),"signal",%s,"","")`, expression, promString(name))
	}
	baseline := `max(driftmower_security_inventory_timestamp_seconds) * 0`
	zero := func(expression string) string { return "(" + expression + ") or (" + baseline + ")" }
	parts := []string{}
	switch in.Signal {
	case "cves":
		running := `max by (digest) (` + metric("driftmower_running_image_containers") + ` > 0)`
		baseline = `(max(driftmower_security_inventory_timestamp_seconds) * on () (max(driftmower_scanner_inventory_ready) == 1)) * 0`
		for _, severity := range []string{"CRITICAL", "HIGH"} {
			findings := `max by (digest,severity,fix_status) (driftmower_image_vulnerabilities{severity=` + promString(severity) + `})`
			parts = append(parts, label(zero(`sum(`+findings+` and on (digest) `+running+`)`), strings.ToLower(severity)))
		}
		parts = append(parts, label(zero(`count(`+running+` unless on (digest) (max by (digest) (driftmower_image_scan_available) == 1))`), "unscanned_images"))
		parts = append(parts, label(zero(`sum(max by (namespace) (`+metric("driftmower_running_image_unresolved_containers")+`))`), "unresolved_containers"))
	case "serviceaccounts":
		admin := `max by (namespace,serviceaccount) (driftmower_serviceaccount_exposure{` + selector
		if selector != "" {
			admin += ","
		}
		admin += `risk="cluster_admin"} > 0)`
		broad := `max by (namespace,serviceaccount) (driftmower_serviceaccount_exposure{` + selector
		if selector != "" {
			broad += ","
		}
		broad += `risk!="cluster_admin"} > 0) unless on (namespace,serviceaccount) ` + admin
		parts = append(parts, label(zero(`count(`+admin+`)`), "cluster_admin"), label(zero(`count(`+broad+`)`), "broad_permissions"))
	case "technical_debt":
		baseline = `max(` + metric("driftmower_version_status") + `) * 0`
		known := `max by (namespace,uid,image) (` + metric("driftmower_version_releases_behind") + `)`
		version := `(` + known + ` > bool 0)`
		age := fmt.Sprintf(`(clamp_min(time() - max by (namespace,uid,image) (%s),0) / %g) unless on (namespace,uid,image) %s`, metric("driftmower_image_created_timestamp_seconds"), in.BuildAgeDaysPerUpgrade*86400, known)
		units := version + ` or (` + age + `)`
		parts = append(parts, label(zero(fmt.Sprintf(`sum(max by (namespace,uid) (%s)) * %g`, units, in.HoursPerUpgrade)), "hours"))
		parts = append(parts, label(zero(`count(max by (namespace,uid) (`+known+` > 0))`), "version_backlog"))
		parts = append(parts, label(zero(`count(max by (namespace,uid) (`+age+`))`), "build_age_fallback"))
		parts = append(parts, label(zero(`count(max by (namespace,uid) (max by (namespace,uid,image) (`+metric("driftmower_version_status")+`) unless on (namespace,uid,image) (`+units+`)))`), "unknown"))
	default:
		return "", errors.New("unsupported historical signal")
	}
	return strings.Join(parts, " or "), nil
}
