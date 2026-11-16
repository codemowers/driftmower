package observability

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"
	"sync"

	"golang.org/x/sync/errgroup"

	"github.com/codemowers/driftmower/mcp/internal/authz"
)

// ResourceTriplet is current usage beside the summed requests and limits;
// each is nil when Prometheus has no sample.
type ResourceTriplet struct {
	Usage   *float64 `json:"usage"`
	Limit   *float64 `json:"limit"`
	Request *float64 `json:"request"`
}

type PodResources struct {
	PodName  string          `json:"podName"`
	Memory   ResourceTriplet `json:"memory"`
	CPU      ResourceTriplet `json:"cpu"`
	QOSClass *string         `json:"qosClass"`
}

// ClaimUsage is the kubelet's view of one PVC the Pods mount.
type ClaimUsage struct {
	Name     string  `json:"name"`
	Used     float64 `json:"used"`
	Capacity float64 `json:"capacity"`
}

type QOSCount struct {
	QOSClass string `json:"qosClass"`
	Count    int    `json:"count"`
}

// WorkloadResources sums its Pods' memory and CPU; volumes are deduplicated
// by claim.
type WorkloadResources struct {
	Namespace    string          `json:"namespace"`
	Memory       ResourceTriplet `json:"memory"`
	CPU          ResourceTriplet `json:"cpu"`
	Volumes      []ClaimUsage    `json:"volumes"`
	QOSClass     *string         `json:"qosClass"`
	QOSBreakdown []QOSCount      `json:"qosBreakdown"`
	ReplicaCount int             `json:"replicaCount"`
	PerPod       []PodResources  `json:"perPod"`
	Warnings     []string        `json:"warnings"`
}

// WorkloadUsage reports memory and CPU (working set or rate, requests and
// limits), QoS class and PVC usage for the named Pods of one namespace.
func (s *Service) WorkloadUsage(ctx context.Context, id authz.Identity, namespace string, pods []string) (*WorkloadResources, error) {
	if s.PrometheusURL == "" {
		return nil, errors.New("PROMETHEUS_URL is not configured")
	}
	if len(pods) == 0 {
		return nil, errors.New("the workload has no current Pods")
	}
	quoted := make([]string, len(pods))
	for i, p := range pods {
		quoted[i] = regexp.QuoteMeta(p)
	}
	sel := "namespace=" + promString(namespace) + ",pod=~" + promString(strings.Join(quoted, "|"))
	containers := sel + `,container!="",container!="POD"`
	claims := fmt.Sprintf("kube_pod_spec_volumes_persistentvolumeclaims_info{%s}", sel)
	queries := map[string]string{
		"memUsage":    fmt.Sprintf("sum by (namespace,pod) (container_memory_working_set_bytes{%s})", containers),
		"memLimit":    fmt.Sprintf(`sum by (namespace,pod) (kube_pod_container_resource_limits{%s,resource="memory"})`, sel),
		"memRequest":  fmt.Sprintf(`sum by (namespace,pod) (kube_pod_container_resource_requests{%s,resource="memory"})`, sel),
		"cpuUsage":    fmt.Sprintf("sum by (namespace,pod) (rate(container_cpu_usage_seconds_total{%s}[5m]))", containers),
		"cpuLimit":    fmt.Sprintf(`sum by (namespace,pod) (kube_pod_container_resource_limits{%s,resource="cpu"})`, sel),
		"cpuRequest":  fmt.Sprintf(`sum by (namespace,pod) (kube_pod_container_resource_requests{%s,resource="cpu"})`, sel),
		"volUsed":     fmt.Sprintf("max by (persistentvolumeclaim) (kubelet_volume_stats_used_bytes{namespace=%s} and on (persistentvolumeclaim) %s)", promString(namespace), claims),
		"volCapacity": fmt.Sprintf("max by (persistentvolumeclaim) (kubelet_volume_stats_capacity_bytes{namespace=%s} and on (persistentvolumeclaim) %s)", promString(namespace), claims),
		"qos":         fmt.Sprintf("kube_pod_status_qos_class{%s} == 1", sel),
		"finished":    fmt.Sprintf(`kube_pod_status_phase{%s,phase=~"Succeeded|Failed"} == 1`, sel),
	}

	var out *WorkloadResources
	err := func(backend Requester) error {
		if err := s.require(ctx, id, authz.Attributes{Namespace: namespace, Resource: "pods", Verb: "list"},
			"Kubernetes RBAC denied list pods in namespace "+namespace); err != nil {
			return err
		}
		at := s.alignedNow().UTC().Format("2006-01-02T15:04:05.000Z")
		results := map[string][]Sample{}
		var mu sync.Mutex
		var warnings []string
		g, gctx := errgroup.WithContext(ctx)
		for name, q := range queries {
			g.Go(func() error {
				samples, w, err := s.vector(gctx, backend, q, at)
				mu.Lock()
				defer mu.Unlock()
				if err != nil {
					warnings = append(warnings, name+": "+err.Error())

					return nil
				}
				warnings = append(warnings, w...)
				results[name] = samples

				return nil
			})
		}
		_ = g.Wait()

		perPod := map[string]*PodResources{}
		for _, p := range pods {
			perPod[p] = &PodResources{PodName: p}
		}
		// Completed and failed Pods run nothing, but kube-state-metrics still
		// reports their requests and limits.
		for _, smp := range results["finished"] {
			if smp.Labels["namespace"] == namespace {
				delete(perPod, smp.Labels["pod"])
			}
		}
		set := func(name string, field func(*PodResources) **float64) {
			for _, smp := range results[name] {
				if p := perPod[smp.Labels["pod"]]; p != nil && smp.Labels["namespace"] == namespace {
					v := smp.Value
					*field(p) = &v
				}
			}
		}
		set("memUsage", func(p *PodResources) **float64 { return &p.Memory.Usage })
		set("memLimit", func(p *PodResources) **float64 { return &p.Memory.Limit })
		set("memRequest", func(p *PodResources) **float64 { return &p.Memory.Request })
		set("cpuUsage", func(p *PodResources) **float64 { return &p.CPU.Usage })
		set("cpuLimit", func(p *PodResources) **float64 { return &p.CPU.Limit })
		set("cpuRequest", func(p *PodResources) **float64 { return &p.CPU.Request })
		for _, smp := range results["qos"] {
			if p := perPod[smp.Labels["pod"]]; p != nil && smp.Labels["qos_class"] != "" {
				qos := smp.Labels["qos_class"]
				p.QOSClass = &qos
			}
		}

		out = &WorkloadResources{Namespace: namespace, Volumes: []ClaimUsage{}, QOSBreakdown: []QOSCount{}, Warnings: orEmpty(warnings)}
		sum := func(dst **float64, v *float64) {
			if v != nil {
				if *dst == nil {
					*dst = new(float64)
				}
				**dst += *v
			}
		}
		qos := map[string]int{}
		for _, name := range slices.Sorted(maps.Keys(perPod)) {
			p := perPod[name]
			out.PerPod = append(out.PerPod, *p)
			sum(&out.Memory.Usage, p.Memory.Usage)
			sum(&out.Memory.Limit, p.Memory.Limit)
			sum(&out.Memory.Request, p.Memory.Request)
			sum(&out.CPU.Usage, p.CPU.Usage)
			sum(&out.CPU.Limit, p.CPU.Limit)
			sum(&out.CPU.Request, p.CPU.Request)
			if p.QOSClass != nil {
				qos[*p.QOSClass]++
			}
		}
		out.ReplicaCount = len(out.PerPod)
		for _, class := range slices.Sorted(maps.Keys(qos)) {
			out.QOSBreakdown = append(out.QOSBreakdown, QOSCount{QOSClass: class, Count: qos[class]})
		}
		if len(qos) == 1 {
			out.QOSClass = &out.QOSBreakdown[0].QOSClass
		}
		capacity := map[string]float64{}
		for _, smp := range results["volCapacity"] {
			capacity[smp.Labels["persistentvolumeclaim"]] = smp.Value
		}
		for _, smp := range results["volUsed"] {
			if c, ok := capacity[smp.Labels["persistentvolumeclaim"]]; ok {
				out.Volumes = append(out.Volumes, ClaimUsage{Name: smp.Labels["persistentvolumeclaim"], Used: smp.Value, Capacity: c})
			}
		}
		slices.SortFunc(out.Volumes, func(a, b ClaimUsage) int { return strings.Compare(a.Name, b.Name) })

		return nil
	}(s.Backend)

	return out, err
}
