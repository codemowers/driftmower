package observability

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sync"

	"golang.org/x/sync/errgroup"

	"github.com/codemowers/driftmower/mcp/internal/authz"
)

// ComputeAmounts are a namespace's ResourceQuota for requests and limits
// beside what its running Pods request, are limited to and use; each is nil
// when Prometheus has no sample.
type ComputeAmounts struct {
	QuotaRequests *float64 `json:"quotaRequests"`
	QuotaLimits   *float64 `json:"quotaLimits"`
	Requests      *float64 `json:"requests"`
	Limits        *float64 `json:"limits"`
	Usage         *float64 `json:"usage"`
}

// StorageAmounts are bytes: the requests.storage quota, the claims'
// requested capacity and the space the kubelet reports used.
type StorageAmounts struct {
	Quota    *float64 `json:"quota"`
	Capacity *float64 `json:"capacity"`
	Usage    *float64 `json:"usage"`
}

// BucketAmounts sum MinIO buckets named "<namespace>.<name>": their quotas,
// which are what the namespace asked for, and their usage in bytes.
type BucketAmounts struct {
	Count    int      `json:"count"`
	Requests *float64 `json:"requests"`
	Usage    *float64 `json:"usage"`
}

type NamespaceResources struct {
	Namespace string         `json:"namespace"`
	CPU       ComputeAmounts `json:"cpu"`
	Memory    ComputeAmounts `json:"memory"`
	Storage   StorageAmounts `json:"storage"`
	Buckets   BucketAmounts  `json:"buckets"`
	// PromQL behind each figure, for links to graphs: "cpu.usage",
	// "memory.requests", "storage.usage", "buckets.usage" and so on.
	Queries  map[string]string `json:"queries"`
	Warnings []string          `json:"warnings"`
}

// bucketPattern matches the MinIO buckets of a namespace.
func bucketPattern(namespace string) string {
	return regexp.QuoteMeta(namespace) + `\..+`
}

// NamespaceResources sums a namespace's CPU, memory, claim and bucket
// quotas, requests, limits and usage from Prometheus.
func (s *Service) NamespaceResources(ctx context.Context, id authz.Identity, namespace string) (*NamespaceResources, error) {
	if s.PrometheusURL == "" {
		return nil, errors.New("PROMETHEUS_URL is not configured")
	}
	ns := "namespace=" + promString(namespace)
	// kube-state-metrics keeps finished Pods' requests; count running and
	// pending ones only.
	live := fmt.Sprintf(`* on (namespace,pod) group_left () max by (namespace,pod) (kube_pod_status_phase{%s,phase=~"Pending|Running"} == 1)`, ns)
	podResource := func(metric, resource string) string {
		return fmt.Sprintf(`sum(max by (namespace,pod,container) (%s{%s,resource=%s}) %s)`, metric, ns, promString(resource), live)
	}
	quota := func(resources string) string {
		return fmt.Sprintf(`sum(max by (resourcequota,resource) (kube_resourcequota{%s,type="hard",resource=~%s}))`, ns, promString(resources))
	}
	containers := ns + `,container!="",container!="POD"`
	bucket := "bucket=~" + promString(bucketPattern(namespace))
	queries := map[string]string{
		"cpu.quotaRequests":    quota(`requests\.cpu|cpu`),
		"cpu.quotaLimits":      quota(`limits\.cpu`),
		"cpu.requests":         podResource("kube_pod_container_resource_requests", "cpu"),
		"cpu.limits":           podResource("kube_pod_container_resource_limits", "cpu"),
		"cpu.usage":            fmt.Sprintf("sum(rate(container_cpu_usage_seconds_total{%s}[5m]))", containers),
		"memory.quotaRequests": quota(`requests\.memory|memory`),
		"memory.quotaLimits":   quota(`limits\.memory`),
		"memory.requests":      podResource("kube_pod_container_resource_requests", "memory"),
		"memory.limits":        podResource("kube_pod_container_resource_limits", "memory"),
		"memory.usage":         fmt.Sprintf("sum(container_memory_working_set_bytes{%s})", containers),
		"storage.quota":        quota(`requests\.storage`),
		"storage.capacity":     fmt.Sprintf("sum(max by (persistentvolumeclaim) (kube_persistentvolumeclaim_resource_requests_storage_bytes{%s}))", ns),
		"storage.usage":        fmt.Sprintf("sum(max by (persistentvolumeclaim) (kubelet_volume_stats_used_bytes{%s}))", ns),
		"buckets.requests":     fmt.Sprintf("sum(max by (bucket) (minio_bucket_quota_total_bytes{%s}))", bucket),
		"buckets.usage":        fmt.Sprintf("sum(max by (bucket) (minio_bucket_usage_total_bytes{%s}))", bucket),
		"buckets.count":        fmt.Sprintf("count(max by (bucket) (minio_bucket_usage_total_bytes{%s}))", bucket),
	}

	out := &NamespaceResources{Namespace: namespace, Queries: queries, Warnings: []string{}}
	fields := map[string]**float64{
		"cpu.quotaRequests": &out.CPU.QuotaRequests, "cpu.quotaLimits": &out.CPU.QuotaLimits,
		"cpu.requests": &out.CPU.Requests, "cpu.limits": &out.CPU.Limits, "cpu.usage": &out.CPU.Usage,
		"memory.quotaRequests": &out.Memory.QuotaRequests, "memory.quotaLimits": &out.Memory.QuotaLimits,
		"memory.requests": &out.Memory.Requests, "memory.limits": &out.Memory.Limits, "memory.usage": &out.Memory.Usage,
		"storage.quota": &out.Storage.Quota, "storage.capacity": &out.Storage.Capacity, "storage.usage": &out.Storage.Usage,
		"buckets.requests": &out.Buckets.Requests, "buckets.usage": &out.Buckets.Usage,
	}
	err := func(backend Requester) error {
		if err := s.require(ctx, id, authz.Attributes{Namespace: namespace, Resource: "pods", Verb: "list"},
			"Kubernetes RBAC denied list pods in namespace "+namespace); err != nil {
			return err
		}
		at := s.alignedNow().UTC().Format("2006-01-02T15:04:05.000Z")
		var mu sync.Mutex
		g, gctx := errgroup.WithContext(ctx)
		for name, q := range queries {
			g.Go(func() error {
				samples, warnings, err := s.vector(gctx, backend, q, at)
				mu.Lock()
				defer mu.Unlock()
				if err != nil {
					out.Warnings = append(out.Warnings, name+": "+err.Error())

					return nil
				}
				out.Warnings = append(out.Warnings, warnings...)
				if len(samples) == 0 {
					return nil
				}
				v := samples[0].Value
				if name == "buckets.count" {
					out.Buckets.Count = int(v)
				} else {
					*fields[name] = &v
				}

				return nil
			})
		}

		return g.Wait()
	}(s.Backend)
	if err != nil {
		return nil, err
	}

	return out, nil
}

// clusterBuckets sums every MinIO bucket's quota and usage; nil when MinIO
// reports no buckets.
func (s *Service) clusterBuckets(ctx context.Context, backend Requester) (*BucketAmounts, error) {
	at := s.alignedNow().UTC().Format("2006-01-02T15:04:05.000Z")
	out := &BucketAmounts{}
	for _, q := range []struct {
		query string
		set   func(float64)
	}{
		{"sum(max by (bucket) (minio_bucket_usage_total_bytes))", func(v float64) { out.Usage = &v }},
		{"sum(max by (bucket) (minio_bucket_quota_total_bytes))", func(v float64) { out.Requests = &v }},
		{"count(max by (bucket) (minio_bucket_usage_total_bytes))", func(v float64) { out.Count = int(v) }},
	} {
		samples, _, err := s.vector(ctx, backend, q.query, at)
		if err != nil {
			return nil, err
		}
		if len(samples) > 0 {
			q.set(samples[0].Value)
		}
	}
	if out.Usage == nil && out.Count == 0 {
		return nil, nil
	}

	return out, nil
}
