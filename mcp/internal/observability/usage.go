package observability

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/errgroup"

	"github.com/codemowers/driftmower/mcp/internal/authz"
)

// Statistics summarise a sampled history. stddev is the population standard
// deviation.
type Statistics struct {
	Avg             float64 `json:"avg"`
	Min             float64 `json:"min"`
	Max             float64 `json:"max"`
	Stddev          float64 `json:"stddev"`
	SampleCount     int     `json:"sampleCount"`
	ExpectedSamples int     `json:"expectedSamples"`
	Coverage        float64 `json:"coverage"`
	FirstSampleAt   string  `json:"firstSampleAt,omitempty"`
	LastSampleAt    string  `json:"lastSampleAt,omitempty"`
}

// SummarizeSamples uses Welford's algorithm. It returns nil without samples.
func SummarizeSamples(values []float64, expected int, timestamps []float64) *Statistics {
	if len(values) == 0 {
		return nil
	}
	var avg, m2 float64
	minimum, maximum := math.Inf(1), math.Inf(-1)
	for i, v := range values {
		n := float64(i + 1)
		delta := v - avg
		avg += delta / n
		m2 += delta * (v - avg)
		minimum, maximum = math.Min(minimum, v), math.Max(maximum, v)
	}
	s := &Statistics{Avg: avg, Min: minimum, Max: maximum, Stddev: math.Sqrt(math.Max(0, m2/float64(len(values)))),
		SampleCount: len(values), ExpectedSamples: expected, Coverage: float64(len(values)) / float64(expected)}
	if len(timestamps) > 0 {
		s.FirstSampleAt = isoSeconds(slices.Min(timestamps))
		s.LastSampleAt = isoSeconds(slices.Max(timestamps))
	}

	return s
}

func isoSeconds(t float64) string {
	return time.UnixMilli(int64(math.Round(t * 1000))).UTC().Format("2006-01-02T15:04:05.000Z")
}

type Sample struct {
	Labels     map[string]string `json:"labels"`
	Value      float64           `json:"value"`
	Statistics *Statistics       `json:"statistics,omitempty"`
}

type SeriesStatistics struct {
	Labels     map[string]string `json:"labels"`
	Statistics *Statistics       `json:"statistics"`
}

// Quantity is one figure: its total over the returned series, provenance,
// and optionally per-series breakdown and history statistics. A nil total is
// unavailable, not zero.
type Quantity struct {
	Unit             string             `json:"unit"`
	SourceMetrics    []string           `json:"sourceMetrics,omitempty"`
	Calculation      string             `json:"calculation,omitempty"`
	Total            *float64           `json:"total"`
	Statistics       *Statistics        `json:"statistics,omitempty"`
	StatisticsError  string             `json:"statisticsError,omitempty"`
	HistoryBreakdown []SeriesStatistics `json:"historyBreakdown,omitempty"`
	Breakdown        []Sample           `json:"breakdown,omitempty"`
	Query            string             `json:"query,omitempty"`
	Warnings         []string           `json:"warnings"`
	Error            string             `json:"error,omitempty"`

	// Per-timestamp totals, kept only to derive ratio histories.
	history map[float64]float64
}

type History struct {
	Seconds        int     `json:"seconds"`
	StepSeconds    int     `json:"stepSeconds"`
	Stddev         string  `json:"stddev"`
	RequestedStart string  `json:"requestedStart"`
	RequestedEnd   string  `json:"requestedEnd"`
	FirstSampleAt  *string `json:"firstSampleAt"`
	LastSampleAt   *string `json:"lastSampleAt"`
}

type Usage struct {
	Source        string               `json:"source"`
	ObservedAt    string               `json:"observedAt"`
	Metrics       map[string]*Quantity `json:"metrics"`
	History       *History             `json:"history,omitempty"`
	Namespace     string               `json:"namespace,omitempty"`
	Pod           string               `json:"pod,omitempty"`
	WindowSeconds int                  `json:"windowSeconds"`
	Notes         []string             `json:"notes"`
}

type definition struct {
	unit, query string
}

// HistoryInput asks for statistics over a past range.
type HistoryInput struct {
	HistorySeconds int
	StepSeconds    int
}

type scope struct{ namespace, pod string }

// The metric families in a query. A metric name is followed by a selector,
// a grouping, a range or whitespace.
var sourceMetric = regexp.MustCompile(`\b((?:container|node|kube|kubelet|topolvm)_[a-zA-Z0-9_:]+)\s*[{}()\[\s]`)

func sourceMetrics(query string) []string {
	var out []string
	for _, m := range sourceMetric.FindAllStringSubmatch(query, -1) {
		if !slices.Contains(out, m[1]) {
			out = append(out, m[1])
		}
	}

	return out
}

const maxSeries, maxHistorySamples = 10000, 100000

func labelKey(labels map[string]string) string {
	var b strings.Builder
	for _, k := range slices.Sorted(maps.Keys(labels)) {
		b.WriteString(k + "\x00" + labels[k] + "\x00")
	}

	return b.String()
}

// alignedNow is the evaluation time, aligned so a refresh within the window
// asks the identical query. Relative to the Unix epoch, as Prometheus
// timestamps are.
func (s *Service) alignedNow() time.Time {
	current := s.now()
	if s.Alignment > 0 {
		ms, align := current.UnixMilli(), s.Alignment.Milliseconds()
		current = time.UnixMilli(ms - ms%align)
	}

	return current
}

func (s *Service) snapshot(ctx context.Context, backend Requester, queries map[string]definition, breakdown bool, history *HistoryInput, sc *scope) (*Usage, error) {
	if s.PrometheusURL == "" {
		return nil, errors.New("PROMETHEUS_URL is not configured")
	}
	current := s.alignedNow()
	observedAt := current.UTC().Format("2006-01-02T15:04:05.000Z")
	end := float64(current.UnixMilli()) / 1000
	start := end
	expected := 0
	if history != nil {
		start = end - float64(history.HistorySeconds)
		expected = history.HistorySeconds/history.StepSeconds + 1
	}

	usage := &Usage{Source: "prometheus", ObservedAt: observedAt, Metrics: map[string]*Quantity{}}
	var mu sync.Mutex
	g, gctx := errgroup.WithContext(ctx)
	// A fixed query count, four at a time.
	g.SetLimit(4)
	for _, name := range slices.Sorted(maps.Keys(queries)) {
		def := queries[name]
		q := &Quantity{Unit: def.unit, SourceMetrics: sourceMetrics(def.query),
			Calculation: "Sum of deduplicated returned series; exact aggregation is in query", Query: def.query, Warnings: []string{}}
		usage.Metrics[name] = q
		g.Go(func() error {
			err := s.evaluate(gctx, backend, q, observedAt, breakdown, sc)
			if err == nil && history != nil {
				if herr := s.evaluateHistory(gctx, backend, q, start, end, history.StepSeconds, expected, sc); herr != nil {
					mu.Lock()
					q.StatisticsError = herr.Error()
					mu.Unlock()
				}
			}
			if err != nil {
				mu.Lock()
				q.Error = err.Error()
				mu.Unlock()
			}

			return nil
		})
	}
	_ = g.Wait()
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	if history != nil {
		var actual []string
		for _, q := range usage.Metrics {
			if q.Statistics != nil && q.Statistics.FirstSampleAt != "" {
				actual = append(actual, q.Statistics.FirstSampleAt, q.Statistics.LastSampleAt)
			}
		}
		slices.Sort(actual)
		h := &History{Seconds: history.HistorySeconds, StepSeconds: history.StepSeconds, Stddev: "population",
			RequestedStart: isoSeconds(start), RequestedEnd: observedAt}
		if len(actual) > 0 {
			h.FirstSampleAt, h.LastSampleAt = &actual[0], &actual[len(actual)-1]
		}
		usage.History = h
	}

	return usage, nil
}

func inScope(labels map[string]string, sc *scope) bool {
	return sc == nil || (labels["namespace"] == sc.namespace && labels["pod"] == sc.pod)
}

func (s *Service) evaluate(ctx context.Context, backend Requester, q *Quantity, observedAt string, breakdown bool, sc *scope) error {
	u := endpoint(s.PrometheusURL, "/api/v1/query")
	v := u.Query()
	v.Set("query", q.Query)
	v.Set("time", observedAt)
	v.Set("limit", strconv.Itoa(maxSeries+1))
	u.RawQuery = v.Encode()

	var resp promResponse
	if err := get(ctx, backend, u, "Prometheus", &resp); err != nil {
		return err
	}
	if err := resp.check("vector"); err != nil {
		return err
	}
	if len(resp.Data.Result) > maxSeries {
		return errors.New("metric exceeded the series limit; incomplete results discarded")
	}
	samples := make([]Sample, 0, len(resp.Data.Result))
	total := 0.0
	for _, series := range resp.Data.Result {
		if !inScope(series.Metric, sc) {
			return errors.New("Prometheus returned a result outside the requested pod") //nolint:staticcheck // Prometheus is a proper noun.
		}
		if series.Value == nil {
			return errors.New("metric sample missing")
		}
		value, err := strconv.ParseFloat(series.Value.Value, 64)
		if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
			return errors.New("metric contains a non-finite sample")
		}
		samples = append(samples, Sample{Labels: series.Metric, Value: value})
		total += value
	}
	q.Warnings = append(q.Warnings, resp.Warnings...)
	q.Warnings = append(q.Warnings, resp.Infos...)
	if len(samples) > 0 {
		q.Total = &total
	} else {
		q.Warnings = append(q.Warnings, "No samples available")
	}
	if breakdown {
		q.Breakdown = samples
	}

	return nil
}

func (s *Service) evaluateHistory(ctx context.Context, backend Requester, q *Quantity, start, end float64, step, expected int, sc *scope) error {
	u := endpoint(s.PrometheusURL, "/api/v1/query_range")
	v := u.Query()
	v.Set("query", q.Query)
	v.Set("limit", strconv.Itoa(maxSeries+1))
	v.Set("start", strconv.FormatFloat(start, 'f', -1, 64))
	v.Set("end", strconv.FormatFloat(end, 'f', -1, 64))
	v.Set("step", strconv.Itoa(step))
	u.RawQuery = v.Encode()

	var resp promResponse
	if err := get(ctx, backend, u, "Prometheus range query", &resp); err != nil {
		return err
	}
	if err := resp.check("matrix"); err != nil {
		return err
	}
	count := 0
	for _, series := range resp.Data.Result {
		count += len(series.Values)
	}
	if len(resp.Data.Result) > maxSeries || count > maxHistorySamples {
		return errors.New("history exceeded the sample limit")
	}
	for _, series := range resp.Data.Result {
		if !inScope(series.Metric, sc) {
			return errors.New("Prometheus history returned a result outside the requested pod") //nolint:staticcheck // Prometheus is a proper noun.
		}
	}
	q.Warnings = append(q.Warnings, resp.Warnings...)
	q.Warnings = append(q.Warnings, resp.Infos...)

	totals, counts := map[float64]float64{}, map[float64]int{}
	perSeries := map[string]*Statistics{}
	nonFinite := false
	for _, series := range resp.Data.Result {
		var values, stamps []float64
		for _, smp := range series.Values {
			value, err := strconv.ParseFloat(smp.Value, 64)
			if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
				nonFinite = true

				continue
			}
			values = append(values, value)
			stamps = append(stamps, smp.Time)
			totals[smp.Time] += value
			counts[smp.Time]++
		}
		stats := SummarizeSamples(values, expected, stamps)
		perSeries[labelKey(series.Metric)] = stats
		if q.Breakdown != nil {
			q.HistoryBreakdown = append(q.HistoryBreakdown, SeriesStatistics{Labels: series.Metric, Statistics: stats})
		}
	}
	if nonFinite {
		q.Warnings = append(q.Warnings, "Non-finite history sample omitted")
	}

	q.history = totals
	stamps := slices.Sorted(maps.Keys(totals))
	values := make([]float64, len(stamps))
	for i, t := range stamps {
		values[i] = totals[t]
	}
	q.Statistics = SummarizeSamples(values, expected, stamps)
	if q.Statistics != nil && q.Statistics.Coverage < 1 {
		q.Warnings = append(q.Warnings, "History has missing time samples; statistics use available samples only")
	}
	seen := map[int]bool{}
	for _, c := range counts {
		seen[c] = true
	}
	if len(seen) > 1 {
		q.Warnings = append(q.Warnings, "History series coverage changes over time; totals may cover different resources")
	}
	for i := range q.Breakdown {
		q.Breakdown[i].Statistics = perSeries[labelKey(q.Breakdown[i].Labels)]
	}

	return nil
}

// ratio derives numerator/denominator, per series and per timestamp.
func ratio(metrics map[string]*Quantity, name, numerator, denominator string) {
	a, b := metrics[numerator], metrics[denominator]
	q := &Quantity{Unit: "ratio", Calculation: numerator + " / " + denominator, Warnings: []string{}}
	var sources []string
	for _, m := range slices.Concat(a.SourceMetrics, b.SourceMetrics) {
		if !slices.Contains(sources, m) {
			sources = append(sources, m)
		}
	}
	q.SourceMetrics = sources
	switch {
	case a.Total == nil || b.Total == nil:
		q.Warnings = append(q.Warnings, "Required metric unavailable")
	case *b.Total <= 0:
		q.Warnings = append(q.Warnings, "Ratio undefined: denominator is zero")
	default:
		r := *a.Total / *b.Total
		q.Total = &r
	}
	if a.Breakdown != nil && b.Breakdown != nil {
		denominators := map[string]float64{}
		for _, smp := range b.Breakdown {
			denominators[labelKey(smp.Labels)] = smp.Value
		}
		q.Breakdown = []Sample{}
		for _, smp := range a.Breakdown {
			if d, ok := denominators[labelKey(smp.Labels)]; ok && d > 0 {
				q.Breakdown = append(q.Breakdown, Sample{Labels: smp.Labels, Value: smp.Value / d})
			}
		}
	}
	if a.history != nil && b.history != nil {
		var values, stamps []float64
		for _, t := range slices.Sorted(maps.Keys(a.history)) {
			if d, ok := b.history[t]; ok && d > 0 {
				stamps = append(stamps, t)
				values = append(values, a.history[t]/d)
			}
		}
		expected := 1
		if a.Statistics != nil {
			expected = a.Statistics.ExpectedSamples
		}
		q.Statistics = SummarizeSamples(values, expected, stamps)
	}
	metrics[name] = q
}

type PodUsageInput struct {
	Namespace     string
	Pod           string
	WindowSeconds int
	PerContainer  bool
}

// PodUsage reports one pod's CPU, memory, throttling, network and filesystem
// usage from fixed PromQL.
func (s *Service) PodUsage(ctx context.Context, id authz.Identity, in PodUsageInput, history *HistoryInput) (*Usage, error) {
	var usage *Usage
	err := func(backend Requester) error {
		if err := s.require(ctx, id, authz.Attributes{Namespace: in.Namespace, Resource: "pods", Verb: "list"},
			"Kubernetes RBAC denied list pods in namespace "+in.Namespace); err != nil {
			return err
		}
		selector := "namespace=" + promString(in.Namespace) + ",pod=" + promString(in.Pod)
		containers := selector + `,container!="",container!="POD"`
		const groups = "namespace,pod,container"
		window := strconv.Itoa(in.WindowSeconds)
		gauge := func(metric string) string {
			return fmt.Sprintf("max by (%s) (%s{%s})", groups, metric, containers)
		}
		rate := func(metric string) string {
			return fmt.Sprintf("max by (%s) (rate(%s{%s}[%ss]))", groups, metric, containers, window)
		}
		resource := func(metric, name string) string {
			return fmt.Sprintf(`max by (%s) (%s{%s,resource="%s"})`, groups, metric, selector, name)
		}
		volume := func(metric string) string {
			return fmt.Sprintf("max by (namespace,pod,persistentvolumeclaim) (max by (namespace,persistentvolumeclaim) (%s) * on (namespace,persistentvolumeclaim) group_right() "+
				"(max by (namespace,pod,persistentvolumeclaim) (kube_pod_spec_volumes_persistentvolumeclaims_info{%s})))", metric, selector)
		}
		network := func(metric string) string {
			return fmt.Sprintf(`max by (namespace,pod,interface) (rate(%s{%s,interface!="lo"}[%ss]))`, metric, selector, window)
		}
		queries := map[string]definition{
			"cpuUsed":             {"cores", rate("container_cpu_usage_seconds_total")},
			"cpuRequests":         {"cores", resource("kube_pod_container_resource_requests", "cpu")},
			"cpuLimits":           {"cores", resource("kube_pod_container_resource_limits", "cpu")},
			"cpuThrottledPeriods": {"periods/second", rate("container_cpu_cfs_throttled_periods_total")},
			"cpuPeriods":          {"periods/second", rate("container_cpu_cfs_periods_total")},
			"memoryWorkingSet":    {"bytes", gauge("container_memory_working_set_bytes")},
			"memoryUsage":         {"bytes", gauge("container_memory_usage_bytes")},
			"memoryRequests":      {"bytes", resource("kube_pod_container_resource_requests", "memory")},
			"memoryLimits":        {"bytes", resource("kube_pod_container_resource_limits", "memory")},
			"networkRx":           {"bytes/second", network("container_network_receive_bytes_total")},
			"networkTx":           {"bytes/second", network("container_network_transmit_bytes_total")},
			"volumeUsage":         {"bytes", volume("kubelet_volume_stats_used_bytes")},
			"volumeCapacity":      {"bytes", volume("kubelet_volume_stats_capacity_bytes")},
			"filesystemUsage":     {"bytes", fmt.Sprintf("max by (namespace,pod,container,device) (container_fs_usage_bytes{%s})", containers)},
		}
		var err error
		usage, err = s.snapshot(ctx, backend, queries, in.PerContainer, history, &scope{in.Namespace, in.Pod})
		if err != nil {
			return err
		}
		ratio(usage.Metrics, "cpuThrottling", "cpuThrottledPeriods", "cpuPeriods")
		usage.Namespace, usage.Pod, usage.WindowSeconds = in.Namespace, in.Pod, in.WindowSeconds
		usage.Notes = []string{
			"Requests and limits are sums of reported regular container resources; they exclude init containers, pod overhead and pod-level resources.",
			"Network counters cover the shared pod network namespace and are deduplicated by interface, not attributed to individual containers.",
			"Filesystem usage is reported container filesystem usage. volumeUsage and volumeCapacity cover PVCs attached to this pod, deduplicated by claim; " +
				"shared PVC usage cannot be attributed to this pod alone. Missing samples mean unavailable, not zero.",
		}

		return nil
	}(s.Backend)

	return usage, err
}

type ClusterUsageInput struct {
	WindowSeconds int
	PerNode       bool
}

// ClusterUsage reports cluster capacity, utilisation and pressure from
// node-exporter and kube-state-metrics, joined to the Kubernetes node
// inventory.
func (s *Service) ClusterUsage(ctx context.Context, id authz.Identity, in ClusterUsageInput, history *HistoryInput) (*Usage, error) {
	var usage *Usage
	err := func(backend Requester) error {
		for _, resource := range []string{"pods", "nodes"} {
			if err := s.require(ctx, id, authz.Attributes{Resource: resource, Verb: "list"},
				"Kubernetes RBAC denied list "+resource+" cluster-wide"); err != nil {
				return err
			}
		}
		window := strconv.Itoa(in.WindowSeconds)
		// Monitoring may also scrape routers or other hosts, so exporters are
		// joined to the Kubernetes node inventory.
		const inventory = "max by (node) (kube_node_info)"
		identities := `max by (instance,node) (node_uname_info{node!=""} or label_replace(node_uname_info{node=""}, "node", "$1", "nodename", "(.+)")) and on (node) ` + inventory
		host := func(query, labels string) string {
			by := "node"
			if labels != "" {
				by += "," + labels
			}

			return fmt.Sprintf("max by (%s) ((%s) * on (instance) group_left (node) (%s))", by, query, identities)
		}
		node := func(metric string) string { return host("max by (instance) ("+metric+")", "") }
		resources := func(metric, resource string) string {
			return fmt.Sprintf(`sum by (node) (max by (namespace,pod,container,node) (%s{resource="%s"}))`, metric, resource)
		}
		const root = `mountpoint="/"`
		vgSize := "max by (node,device_class) (topolvm_volumegroup_size_bytes) and on (node) " + inventory
		vgAvailable := "max by (node,device_class) (topolvm_volumegroup_available_bytes) and on (node) " + inventory
		const network = `device!~"lo|veth.*|lxc.*|cali.*|cilium.*|flannel.*|docker.*|br-.*|virbr.*|tun.*|tap.*"`
		// Whole disks only: avoid counting both physical devices and their
		// partitions or device-mapper/LVM layers.
		const disks = `device=~"sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme[0-9]+n[0-9]+|mmcblk[0-9]+|hd[a-z]+"`
		ioRate := func(metric, selector string) string {
			return "sum by (node) (" + host(fmt.Sprintf("max by (instance,device) (rate(%s{%s}[%ss]))", metric, selector, window), "device") + ")"
		}
		queries := map[string]definition{
			"cpuUsed":         {"cores", host(fmt.Sprintf(`sum by (instance) (1 - max by (instance,cpu) (rate(node_cpu_seconds_total{mode="idle"}[%ss])))`, window), "")},
			"cpuCapacity":     {"cores", `max by (node) (kube_node_status_capacity{resource="cpu",unit="core"})`},
			"memoryCapacity":  {"bytes", `max by (node) (kube_node_status_capacity{resource="memory",unit="byte"})`},
			"memoryAvailable": {"bytes", node("node_memory_MemAvailable_bytes")},
			"memoryUsed":      {"bytes", node("node_memory_MemTotal_bytes") + " - " + node("node_memory_MemAvailable_bytes")},
			"memoryCached":    {"bytes", node("node_memory_Cached_bytes")},
			"memoryBuffers":   {"bytes", node("node_memory_Buffers_bytes")},
			"cpuRequests":     {"cores", resources("kube_pod_container_resource_requests", "cpu")},
			"cpuLimits":       {"cores", resources("kube_pod_container_resource_limits", "cpu")},
			"memoryRequests":  {"bytes", resources("kube_pod_container_resource_requests", "memory")},
			"memoryLimits":    {"bytes", resources("kube_pod_container_resource_limits", "memory")},
			"rootFilesystemUsed": {"bytes", host(fmt.Sprintf("max by (instance,device,mountpoint) (node_filesystem_size_bytes{%s}) - max by (instance,device,mountpoint) (node_filesystem_free_bytes{%s})", root, root),
				"device,mountpoint")},
			"rootFilesystemCapacity":  {"bytes", host(fmt.Sprintf("max by (instance,device,mountpoint) (node_filesystem_size_bytes{%s})", root), "device,mountpoint")},
			"rootFilesystemAvailable": {"bytes", host(fmt.Sprintf("max by (instance,device,mountpoint) (node_filesystem_avail_bytes{%s})", root), "device,mountpoint")},
			"lvmVolumeGroupSize":      {"bytes", vgSize},
			"lvmVolumeGroupAvailable": {"bytes", vgAvailable},
			"lvmVolumeGroupAllocated": {"bytes", "(" + vgSize + ") - (" + vgAvailable + ")"},
			"networkRx":               {"bytes/second", ioRate("node_network_receive_bytes_total", network)},
			"networkTx":               {"bytes/second", ioRate("node_network_transmit_bytes_total", network)},
			"diskRead":                {"bytes/second", ioRate("node_disk_read_bytes_total", disks)},
			"diskWrite":               {"bytes/second", ioRate("node_disk_written_bytes_total", disks)},
		}
		var err error
		usage, err = s.snapshot(ctx, backend, queries, true, history, nil)
		if err != nil {
			return err
		}
		m := usage.Metrics
		ratio(m, "cpuUtilization", "cpuUsed", "cpuCapacity")
		ratio(m, "memoryUtilization", "memoryUsed", "memoryCapacity")
		ratio(m, "rootFilesystemUtilization", "rootFilesystemUsed", "rootFilesystemCapacity")
		ratio(m, "lvmVolumeGroupAllocation", "lvmVolumeGroupAllocated", "lvmVolumeGroupSize")

		expected := map[string]bool{}
		for _, smp := range m["cpuCapacity"].Breakdown {
			expected[smp.Labels["node"]] = true
		}
		for name, q := range m {
			if !strings.HasSuffix(name, "Requests") && !strings.HasSuffix(name, "Limits") && !strings.HasPrefix(name, "lvm") &&
				len(expected) > 0 && q.Breakdown != nil {
				observed := map[string]bool{}
				for _, smp := range q.Breakdown {
					observed[smp.Labels["node"]] = true
				}
				var missing []string
				for _, n := range slices.Sorted(maps.Keys(expected)) {
					if !observed[n] {
						missing = append(missing, n)
					}
				}
				if len(missing) > 0 {
					q.Warnings = append(q.Warnings, "Partial node coverage; missing: "+strings.Join(missing, ", "))
				}
			}
			if !in.PerNode {
				q.Breakdown, q.HistoryBreakdown = nil, nil
			}
		}
		usage.WindowSeconds = in.WindowSeconds
		usage.Notes = []string{
			"Host usage comes from node-exporter. CPU used includes all non-idle time; memory used is total minus available, not total minus free.",
			"Host totals include Kubernetes nodes only, excluding other monitored hosts such as routers. node_uname_info maps exporter addresses to node names; " +
				"kube_node_info filters those names to the Kubernetes inventory. sourceMetrics and query identify the metrics behind each figure.",
			"Requests and limits sum regular container declarations, not scheduler effective pod requirements.",
			`Root filesystem metrics select mountpoint="/" only. TopoLVM volume-group allocation is size minus available space; it describes allocated LVM capacity, not filesystem data written inside PVCs. ` +
				"Filesystem breakdown retains device and mountpoint; LVM retains device_class. Network and whole-disk rates are summed per node in Prometheus. Network totals exclude common virtual interfaces; bonded or bridged interfaces may still overlap. Disk totals exclude partitions and device-mapper layers.",
			"Missing samples mean unavailable, not zero. This Prometheus endpoint must contain metrics for this cluster only.",
		}

		return nil
	}(s.Backend)

	return usage, err
}
