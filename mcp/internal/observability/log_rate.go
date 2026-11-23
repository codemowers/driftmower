package observability

import (
	"context"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/codemowers/driftmower/mcp/internal/authz"
)

// LogRate is a single scope's stored log entries per second, averaged over five minutes.
// A nil rate means Loki returned no samples, rather than a measured zero.
type LogRate struct {
	Namespace      string   `json:"namespace"`
	Query          string   `json:"query"`
	LinesPerSecond *float64 `json:"linesPerSecond"`
	Warnings       []string `json:"warnings"`
}

func (s *Service) LogRateEnabled() bool { return s.LokiURL != "" }

func (s *Service) LogRate(ctx context.Context, id authz.Identity, namespace, pod string, pods ...string) (*LogRate, error) {
	if !s.LogRateEnabled() {
		return nil, errors.New("LOKI_URL is not configured")
	}
	if namespace == "" || len(pods) > 500 || (pod != "" && len(pods) > 0) {
		return nil, errors.New("namespace and at most one Pod selector are required; select at most 500 Pods")
	}
	for _, name := range pods {
		if name == "" || len(name) > 253 {
			return nil, errors.New("invalid Pod name")
		}
	}
	labels := map[string]string{"namespace": namespace}
	if pod != "" {
		labels["pod"] = pod
	}
	quoted := make([]string, len(pods))
	for i, name := range pods {
		quoted[i] = regexp.QuoteMeta(name)
	}
	query := "sum(rate(" + logQL(labels, strings.Join(quoted, "|")) + "[5m]))"
	out := &LogRate{Namespace: namespace, Query: query, Warnings: []string{}}
	err := func(backend Requester) error {
		if err := s.require(ctx, id, authz.Attributes{Namespace: namespace, Resource: "pods", Verb: "list"}, "Kubernetes RBAC denied list pods in namespace "+namespace); err != nil {
			return err
		}
		names := pods
		if pod != "" {
			names = []string{pod}
		}
		if len(names) == 0 {
			names = []string{""}
		}
		for _, name := range names {
			if err := s.require(ctx, id, authz.Attributes{Namespace: namespace, Resource: "pods", Subresource: "log", Verb: "get", Name: name}, "Kubernetes RBAC denied get pods/log in namespace "+namespace); err != nil {
				return err
			}
		}
		u := endpoint(s.LokiURL, "/loki/api/v1/query")
		q := u.Query()
		q.Set("query", query)
		q.Set("time", strconv.FormatInt(s.alignedNow().UnixNano(), 10))
		u.RawQuery = q.Encode()
		var response promResponse
		if err := get(ctx, backend, u, "Loki log-rate query", &response); err != nil {
			return err
		}
		if response.Status != "success" || response.Data.ResultType != "vector" || len(response.Data.Result) > 1 {
			return errors.New("loki returned an unexpected aggregate log-rate response")
		}
		out.Warnings = append(out.Warnings, response.Warnings...)
		for _, sample := range response.Data.Result {
			if len(sample.Metric) != 0 || sample.Value == nil {
				return errors.New("loki returned an unexpected aggregate log-rate sample")
			}
			value, err := strconv.ParseFloat(sample.Value.Value, 64)
			if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
				return errors.New("loki returned an invalid log rate")
			}
			out.LinesPerSecond = &value
		}
		return nil
	}(s.Backend)
	return out, err
}

// NamespaceSummary compares namespaces: what their running and pending Pods
// request. Missing figures are null.
type NamespaceSummary struct {
	CPURequests    *float64 `json:"cpuRequests"`
	MemoryRequests *float64 `json:"memoryRequests"`
}

type NamespaceSummaries struct {
	Namespaces map[string]*NamespaceSummary `json:"namespaces"`
	Warnings   []string                     `json:"warnings"`
}

const maxSummaryNamespaces = 500

// NamespaceSummaries answers for the namespaces the caller may list Pods in;
// the others are left out and named in a warning.
func (s *Service) NamespaceSummaries(ctx context.Context, id authz.Identity, namespaces []string) (*NamespaceSummaries, error) {
	if s.PrometheusURL == "" {
		return nil, errors.New("PROMETHEUS_URL is not configured")
	}
	if len(namespaces) > maxSummaryNamespaces {
		return nil, fmt.Errorf("at most %d namespaces", maxSummaryNamespaces)
	}
	out := &NamespaceSummaries{Namespaces: map[string]*NamespaceSummary{}, Warnings: []string{}}
	quoted := []string{}
	for _, ns := range namespaces {
		if s.Judge.MayPerform(ctx, id, authz.Attributes{Namespace: ns, Resource: "pods", Verb: "list"}).Verdict == authz.Yes {
			quoted, out.Namespaces[ns] = append(quoted, regexp.QuoteMeta(ns)), &NamespaceSummary{}
		} else {
			out.Warnings = append(out.Warnings, ns+": list pods is not authorized")
		}
	}
	if len(quoted) == 0 {
		return out, nil
	}
	sel := "namespace=~" + promString(strings.Join(quoted, "|"))
	// kube-state-metrics keeps finished Pods' requests; count running and
	// pending ones only, as get_namespace_resources does.
	live := fmt.Sprintf(`* on (namespace,pod) group_left () max by (namespace,pod) (kube_pod_status_phase{%s,phase=~"Pending|Running"} == 1)`, sel)
	requests := func(resource string) string {
		return fmt.Sprintf(`sum by (namespace) (max by (namespace,pod,container) (kube_pod_container_resource_requests{%s,resource=%s}) %s)`, sel, promString(resource), live)
	}
	queries := map[string]string{"cpu": requests("cpu"), "memory": requests("memory")}

	err := func(backend Requester) error {
		at := s.alignedNow().UTC().Format("2006-01-02T15:04:05.000Z")
		for name, q := range queries {
			samples, warnings, err := s.vector(ctx, backend, q, at)
			if err != nil {
				out.Warnings = append(out.Warnings, name+": "+err.Error())

				continue
			}
			out.Warnings = append(out.Warnings, warnings...)
			for _, smp := range samples {
				summary := out.Namespaces[smp.Labels["namespace"]]
				if summary == nil || math.IsNaN(smp.Value) || math.IsInf(smp.Value, 0) {
					continue
				}
				v := smp.Value
				switch name {
				case "cpu":
					summary.CPURequests = &v
				case "memory":
					summary.MemoryRequests = &v

				}
			}
		}

		return nil
	}(s.Backend)

	return out, err
}
