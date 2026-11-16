package observability

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"maps"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/codemowers/driftmower/mcp/internal/authz"
)

// WorkloadLogsInput selects the logs of one workload's Pods.
type WorkloadLogsInput struct {
	Namespace string
	// The workload's name. Pods named "<name>-…" that no longer run may be
	// matched by a label selector; empty restricts the query to Pods.
	Name string
	// The workload's current Pods.
	Pods []string
	// Every Pod of the namespace, current and replaced, instead of a workload.
	WholeNamespace bool
	Container      string
	Contains       string
	// RFC 3339; the last hour by default.
	Start string
	End   string
	Limit int
}

type WorkloadLogEntry struct {
	// Nanoseconds since the epoch, as a decimal string.
	TsNs      string `json:"tsNs"`
	Pod       string `json:"pod"`
	Container string `json:"container"`
	Line      string `json:"line"`
}

type WorkloadLogsResult struct {
	// loki or kubernetes.
	Source    string `json:"source"`
	Namespace string `json:"namespace"`
	// labels when the workload's shared Loki labels were proven to select
	// only its Pods, which includes Pods that no longer run; namespace for a
	// whole namespace; pods otherwise.
	Selector   string             `json:"selector"`
	Query      string             `json:"query,omitempty"`
	Containers []string           `json:"containers"`
	Entries    []WorkloadLogEntry `json:"entries"`
	Warnings   []string           `json:"warnings"`
}

const (
	maxWorkloadLogLines = 5000
	// Pods read one by one from the Kubernetes API when Loki is absent.
	maxKubernetesLogPods = 20
)

// Loki labels that differ per Pod, container or file, so they cannot
// describe a workload.
var perPodLokiLabels = map[string]bool{
	"pod": true, "uid": true, "container": true, "filename": true, "stream": true,
	"container_runtime": true, "namespace": true, "node_name": true, "node": true, "host": true, "hostname": true,
}

// WorkloadLogs merges the logs of a workload's Pods in time order. With Loki
// it selects the workload by the labels its Pods' streams share, once those
// are shown to match no other live Pod, so earlier Pods of the workload are
// included; otherwise it names the current Pods.
func (s *Service) WorkloadLogs(ctx context.Context, id authz.Identity, in WorkloadLogsInput) (*WorkloadLogsResult, error) {
	if in.Limit == 0 {
		in.Limit = 1000
	}
	if in.Limit < 1 || in.Limit > maxWorkloadLogLines {
		return nil, fmt.Errorf("limit must be between 1 and %d", maxWorkloadLogLines)
	}
	end := s.now()
	if in.End != "" {
		var err error
		if end, err = time.Parse(time.RFC3339Nano, in.End); err != nil {
			return nil, fmt.Errorf("end: %w", err)
		}
	}
	start := end.Add(-time.Hour)
	if in.Start != "" {
		var err error
		if start, err = time.Parse(time.RFC3339Nano, in.Start); err != nil {
			return nil, fmt.Errorf("start: %w", err)
		}
	}
	if err := validateRange(start, end); err != nil {
		return nil, err
	}
	if in.WholeNamespace {
		if err := s.require(ctx, id, authz.Attributes{Namespace: in.Namespace, Resource: "pods", Subresource: "log", Verb: "get"},
			"Kubernetes RBAC denied get pods/log in namespace "+in.Namespace); err != nil {
			return nil, err
		}
	} else if len(in.Pods) == 0 {
		return &WorkloadLogsResult{Source: "none", Namespace: in.Namespace, Selector: "pods", Containers: []string{}, Entries: []WorkloadLogEntry{},
			Warnings: []string{"The workload has no current Pods."}}, nil
	}
	for _, pod := range in.Pods {
		if in.WholeNamespace {
			break
		}
		if err := s.require(ctx, id, authz.Attributes{Namespace: in.Namespace, Resource: "pods", Subresource: "log", Verb: "get", Name: pod},
			"Kubernetes RBAC denied get pods/log for "+pod+" in namespace "+in.Namespace); err != nil {
			return nil, err
		}
	}
	// A label selector reaches Pods that no longer exist, so it needs the
	// right to read every Pod's logs in the namespace.
	if in.Name != "" && s.Judge.MayPerform(ctx, id, authz.Attributes{Namespace: in.Namespace, Resource: "pods", Subresource: "log", Verb: "get"}).Verdict != authz.Yes {
		in.Name = ""
	}

	// Live Pods, read with this server's credentials after the checks above,
	// name the containers and tell other workloads' Pods apart.
	live, err := s.Kubernetes.CoreV1().Pods(in.Namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	current := map[string]*corev1.Pod{}
	alive := map[string]bool{}
	for i := range live.Items {
		alive[live.Items[i].Name] = true
		if in.WholeNamespace || slices.Contains(in.Pods, live.Items[i].Name) {
			current[live.Items[i].Name] = &live.Items[i]
		}
	}
	containers := map[string]bool{}
	for _, p := range current {
		for _, c := range p.Spec.Containers {
			containers[c.Name] = true
		}
	}

	var result *WorkloadLogsResult
	err = func(backend Requester) error {
		var err error
		if s.LokiURL != "" {
			result, err = s.lokiWorkloadLogs(ctx, backend, in, alive, start, end)
		} else {
			result, err = s.kubernetesWorkloadLogs(ctx, in, current, start, end)
		}

		return err
	}(s.Backend)
	if err != nil {
		return nil, err
	}
	for _, e := range result.Entries {
		containers[e.Container] = true
	}
	delete(containers, "")
	result.Containers = slices.Sorted(maps.Keys(containers))

	return result, nil
}

// owns says whether a Pod named in Loki may belong to the workload: one of
// its current Pods, or a Pod that no longer runs and carries its name.
func owns(in WorkloadLogsInput, alive map[string]bool, pod string) bool {
	if in.WholeNamespace || slices.Contains(in.Pods, pod) {
		return true
	}

	return in.Name != "" && !alive[pod] && strings.HasPrefix(pod, in.Name+"-")
}

func logQL(matchers map[string]string, podPattern string) string {
	parts := []string{}
	for _, k := range slices.Sorted(maps.Keys(matchers)) {
		parts = append(parts, k+"="+promString(matchers[k]))
	}
	if podPattern != "" {
		parts = append(parts, "pod=~"+promString(podPattern))
	}

	return "{" + strings.Join(parts, ",") + "}"
}

func (s *Service) lokiSeries(ctx context.Context, backend Requester, selector string, start, end time.Time) ([]map[string]string, error) {
	u := endpoint(s.LokiURL, "/loki/api/v1/series")
	q := url.Values{}
	q.Set("match[]", selector)
	q.Set("start", strconv.FormatInt(start.UnixNano(), 10))
	q.Set("end", strconv.FormatInt(end.UnixNano(), 10))
	u.RawQuery = q.Encode()
	var resp struct {
		Status string              `json:"status"`
		Data   []map[string]string `json:"data"`
	}
	if err := get(ctx, backend, u, "Loki", &resp); err != nil {
		return nil, err
	}
	if resp.Status != "success" {
		return nil, errors.New("Loki returned an unexpected series response") //nolint:staticcheck // Loki is a proper noun.
	}

	return resp.Data, nil
}

// workloadLabels finds the Loki labels every current Pod's streams share
// and checks that they select no Pod of another workload in the range.
func (s *Service) workloadLabels(ctx context.Context, backend Requester, in WorkloadLogsInput, alive map[string]bool, podPattern string, start, end time.Time) map[string]string {
	if in.Name == "" {
		return nil
	}
	base := map[string]string{"namespace": in.Namespace}
	streams, err := s.lokiSeries(ctx, backend, logQL(base, podPattern), start, end)
	if err != nil || len(streams) == 0 {
		return nil
	}
	var common map[string]string
	seen := map[string]bool{}
	for _, labels := range streams {
		seen[labels["pod"]] = true
		if common == nil {
			common = map[string]string{}
			for k, v := range labels {
				if !perPodLokiLabels[k] {
					common[k] = v
				}
			}

			continue
		}
		for k, v := range common {
			if labels[k] != v {
				delete(common, k)
			}
		}
	}
	// Pods without streams in the range give no evidence either way.
	if len(common) == 0 || len(seen) != len(in.Pods) {
		return nil
	}
	maps.Copy(common, base)
	matched, err := s.lokiSeries(ctx, backend, logQL(common, ""), start, end)
	if err != nil {
		return nil
	}
	for _, labels := range matched {
		if labels["namespace"] != in.Namespace || !owns(in, alive, labels["pod"]) {
			return nil
		}
	}

	return common
}

func (s *Service) lokiWorkloadLogs(ctx context.Context, backend Requester, in WorkloadLogsInput, alive map[string]bool, start, end time.Time) (*WorkloadLogsResult, error) {
	quoted := make([]string, len(in.Pods))
	for i, p := range in.Pods {
		quoted[i] = regexp.QuoteMeta(p)
	}
	podPattern := strings.Join(quoted, "|")
	result := &WorkloadLogsResult{Source: "loki", Namespace: in.Namespace, Selector: "pods", Warnings: []string{}}
	query := logQL(map[string]string{"namespace": in.Namespace}, podPattern)
	if in.WholeNamespace {
		result.Selector, query = "namespace", logQL(map[string]string{"namespace": in.Namespace}, "")
	} else if labels := s.workloadLabels(ctx, backend, in, alive, podPattern, start, end); labels != nil {
		result.Selector = "labels"
		query = logQL(labels, "")
	}
	if in.Container != "" {
		query = strings.TrimSuffix(query, "}") + ",container=" + promString(in.Container) + "}"
	}
	if in.Contains != "" {
		query += " |= " + promString(in.Contains)
	}
	result.Query = query

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
	dropped := false
	entries := []WorkloadLogEntry{}
	for _, stream := range resp.Data.Result {
		pod := stream.Stream["pod"]
		if stream.Stream["namespace"] != in.Namespace || !owns(in, alive, pod) || (in.Container != "" && stream.Stream["container"] != in.Container) {
			dropped = true

			continue
		}
		for _, v := range stream.Values {
			if len(v) < 2 {
				continue
			}
			ts, _ := v[0].(string)
			line, _ := v[1].(string)
			if _, err := strconv.ParseInt(ts, 10, 64); err != nil {
				continue
			}
			entries = append(entries, WorkloadLogEntry{TsNs: ts, Pod: pod, Container: stream.Stream["container"], Line: line})
		}
	}
	if dropped {
		result.Warnings = append(result.Warnings, "Streams of Pods outside this workload were left out.")
	}
	result.Entries = newestInOrder(entries, in.Limit)

	return result, nil
}

func (s *Service) kubernetesWorkloadLogs(ctx context.Context, in WorkloadLogsInput, current map[string]*corev1.Pod, start, end time.Time) (*WorkloadLogsResult, error) {
	result := &WorkloadLogsResult{Source: "kubernetes", Namespace: in.Namespace, Selector: "pods", Warnings: []string{
		"Kubernetes keeps only the current and previous run of each container; logs of deleted Pods are unavailable.",
	}}
	names := slices.Sorted(maps.Keys(current))
	if len(names) > maxKubernetesLogPods {
		result.Warnings = append(result.Warnings, fmt.Sprintf("Only %d of %d Pods were read.", maxKubernetesLogPods, len(names)))
		names = names[:maxKubernetesLogPods]
	}
	since := metav1.NewTime(start)
	tail, limitBytes := int64(in.Limit), int64(1<<20)
	entries := []WorkloadLogEntry{}
	for _, name := range names {
		pod := current[name]
		restarted := map[string]bool{}
		for _, st := range pod.Status.ContainerStatuses {
			restarted[st.Name] = st.RestartCount > 0
		}
		for _, c := range pod.Spec.Containers {
			if in.Container != "" && c.Name != in.Container {
				continue
			}
			for _, previous := range []bool{true, false} {
				if previous && !restarted[c.Name] {
					continue
				}
				raw, err := s.Kubernetes.CoreV1().Pods(in.Namespace).GetLogs(name, &corev1.PodLogOptions{
					Container: c.Name, Previous: previous, Timestamps: true, SinceTime: &since, TailLines: &tail, LimitBytes: &limitBytes,
				}).DoRaw(ctx)
				if err != nil {
					if !previous {
						result.Warnings = append(result.Warnings, name+"/"+c.Name+": "+err.Error())
					}

					continue
				}
				for line := range strings.SplitSeq(string(raw), "\n") {
					stamp, text, ok := strings.Cut(line, " ")
					if !ok {
						continue
					}
					t, err := time.Parse(time.RFC3339Nano, stamp)
					if err != nil || t.Before(start) || t.After(end) || (in.Contains != "" && !strings.Contains(text, in.Contains)) {
						continue
					}
					entries = append(entries, WorkloadLogEntry{TsNs: strconv.FormatInt(t.UnixNano(), 10), Pod: name, Container: c.Name, Line: text})
				}
			}
		}
	}
	result.Entries = newestInOrder(entries, in.Limit)

	return result, nil
}

// newestInOrder keeps the newest limit entries, oldest first. Equal
// timestamps keep their source order.
func newestInOrder(entries []WorkloadLogEntry, limit int) []WorkloadLogEntry {
	ns := func(e WorkloadLogEntry) int64 {
		v, _ := strconv.ParseInt(e.TsNs, 10, 64)

		return v
	}
	slices.SortStableFunc(entries, func(a, b WorkloadLogEntry) int { return cmp.Compare(ns(a), ns(b)) })
	if len(entries) > limit {
		entries = entries[len(entries)-limit:]
	}

	return entries
}
