package observability

import (
	"context"
	"errors"
	"maps"
	"math"
	"slices"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/sync/errgroup"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/codemowers/driftmower-mcp/internal/authz"
	"github.com/codemowers/driftmower-mcp/internal/kube"
)

type VolumeUsage struct {
	UsedBytes     *float64 `json:"usedBytes"`
	CapacityBytes *float64 `json:"capacityBytes"`
	Inodes        *float64 `json:"inodes"`
	InodesUsed    *float64 `json:"inodesUsed"`
}

type Claim struct {
	Namespace          string      `json:"namespace"`
	Name               string      `json:"name"`
	Phase              *string     `json:"phase"`
	StorageClass       *string     `json:"storageClass"`
	RequestedStorage   *string     `json:"requestedStorage"`
	ProvisionedStorage *string     `json:"provisionedStorage"`
	VolumeMode         string      `json:"volumeMode"`
	AccessModes        []string    `json:"accessModes"`
	BoundVolume        *string     `json:"boundVolume"`
	Usage              VolumeUsage `json:"usage"`
}

type ClaimRef struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
}

type PersistentVolume struct {
	Name            string    `json:"name"`
	Phase           *string   `json:"phase"`
	CapacityStorage *string   `json:"capacityStorage"`
	StorageClass    *string   `json:"storageClass"`
	VolumeMode      string    `json:"volumeMode"`
	AccessModes     []string  `json:"accessModes"`
	ReclaimPolicy   *string   `json:"reclaimPolicy"`
	CSIDriver       *string   `json:"csiDriver"`
	Claim           *ClaimRef `json:"claim"`
}

type MetricSource struct {
	Field  string `json:"field"`
	Metric string `json:"metric"`
	Query  string `json:"query"`
	Error  string `json:"error,omitempty"`
}

type VolumeDegraded struct {
	Source  string `json:"source"`
	Message string `json:"message"`
}

type Volumes struct {
	ObservedAt        string             `json:"observedAt"`
	Namespace         *string            `json:"namespace"`
	Claims            []Claim            `json:"claims"`
	PersistentVolumes []PersistentVolume `json:"persistentVolumes"`
	MetricSources     []MetricSource     `json:"metricSources"`
	Degraded          []VolumeDegraded   `json:"degraded"`
	Notes             []string           `json:"notes"`
}

func optional(s string) *string {
	if s == "" {
		return nil
	}

	return &s
}

func modes(m []corev1.PersistentVolumeAccessMode) []string {
	out := make([]string, len(m))
	for i, v := range m {
		out[i] = string(v)
	}

	return out
}

func volumeMode(m *corev1.PersistentVolumeMode) string {
	if m == nil {
		return "Filesystem"
	}

	return string(*m)
}

func quantity(list corev1.ResourceList, name corev1.ResourceName) *string {
	if q, ok := list[name]; ok {
		s := q.String()

		return &s
	}

	return nil
}

// describePV never exports CSI volume attributes or secret references.
func describePV(pv *corev1.PersistentVolume) PersistentVolume {
	out := PersistentVolume{
		Name: pv.Name, Phase: optional(string(pv.Status.Phase)), CapacityStorage: quantity(pv.Spec.Capacity, corev1.ResourceStorage),
		StorageClass: optional(pv.Spec.StorageClassName), VolumeMode: volumeMode(pv.Spec.VolumeMode), AccessModes: modes(pv.Spec.AccessModes),
		ReclaimPolicy: optional(string(pv.Spec.PersistentVolumeReclaimPolicy)),
	}
	if pv.Spec.CSI != nil {
		out.CSIDriver = &pv.Spec.CSI.Driver
	}
	if ref := pv.Spec.ClaimRef; ref != nil {
		out.Claim = &ClaimRef{Namespace: ref.Namespace, Name: ref.Name}
	}

	return out
}

var volumeMetrics = []struct{ field, metric string }{
	{"capacityBytes", "kubelet_volume_stats_capacity_bytes"},
	{"inodes", "kubelet_volume_stats_inodes"},
	{"inodesUsed", "kubelet_volume_stats_inodes_used"},
	{"usedBytes", "kubelet_volume_stats_used_bytes"},
}

// ListVolumes inventories PVCs and their PVs from the Kubernetes API, after
// checking the caller's own permissions, and adds kubelet volume usage from
// Prometheus when configured.
func (s *Service) ListVolumes(ctx context.Context, id authz.Identity, namespace string, includeUnbound bool) (*Volumes, error) {
	var result *Volumes
	err := s.admit(id, func(backend Requester) error {
		if s.Judge.MayPerform(ctx, id, authz.Attributes{Namespace: namespace, Resource: "persistentvolumeclaims", Verb: "list"}).Verdict != authz.Yes {
			return errors.New("Kubernetes RBAC denied list persistentvolumeclaims; specify a namespace for scoped access") //nolint:staticcheck // Kubernetes is a proper noun.
		}
		if includeUnbound && s.Judge.MayPerform(ctx, id, authz.Attributes{Resource: "persistentvolumes", Verb: "list"}).Verdict != authz.Yes {
			return errors.New("Kubernetes RBAC denied cluster-wide list persistentvolumes") //nolint:staticcheck // Kubernetes is a proper noun.
		}

		pvcs, err := kube.Collect(ctx, func(ctx context.Context, o metav1.ListOptions) ([]corev1.PersistentVolumeClaim, string, error) {
			l, err := s.Kubernetes.CoreV1().PersistentVolumeClaims(namespace).List(ctx, o)
			if err != nil {
				return nil, "", err
			}

			return l.Items, l.Continue, nil
		}, kube.ListOptions{Limit: 200, MaxPages: 20, What: "PVC listing"})
		if err != nil {
			return err
		}

		var mu sync.Mutex
		degraded := []VolumeDegraded{}
		note := func(source, message string) {
			mu.Lock()
			degraded = append(degraded, VolumeDegraded{Source: source, Message: message})
			mu.Unlock()
		}
		pvs := map[string]PersistentVolume{}
		bound := map[string]bool{}
		claims := make([]Claim, 0, len(pvcs))
		for _, c := range pvcs {
			if c.Namespace == "" || (namespace != "" && c.Namespace != namespace) {
				return errors.New("Kubernetes returned a claim outside the requested namespace") //nolint:staticcheck // Kubernetes is a proper noun.
			}
			if c.Spec.VolumeName != "" {
				bound[c.Spec.VolumeName] = true
			}
			claims = append(claims, Claim{
				Namespace: c.Namespace, Name: c.Name, Phase: optional(string(c.Status.Phase)), StorageClass: c.Spec.StorageClassName,
				RequestedStorage: quantity(c.Spec.Resources.Requests, corev1.ResourceStorage), ProvisionedStorage: quantity(c.Status.Capacity, corev1.ResourceStorage),
				VolumeMode: volumeMode(c.Spec.VolumeMode), AccessModes: modes(c.Spec.AccessModes), BoundVolume: optional(c.Spec.VolumeName),
			})
		}

		if includeUnbound {
			all, err := kube.Collect(ctx, func(ctx context.Context, o metav1.ListOptions) ([]corev1.PersistentVolume, string, error) {
				l, err := s.Kubernetes.CoreV1().PersistentVolumes().List(ctx, o)
				if err != nil {
					return nil, "", err
				}

				return l.Items, l.Continue, nil
			}, kube.ListOptions{Limit: 200, MaxPages: 20, What: "PV listing"})
			if err != nil {
				return err
			}
			for i := range all {
				if bound[all[i].Name] || all[i].Status.Phase != corev1.VolumeBound {
					pvs[all[i].Name] = describePV(&all[i])
				}
			}
		} else {
			g, gctx := errgroup.WithContext(ctx)
			g.SetLimit(4)
			for _, name := range slices.Sorted(maps.Keys(bound)) {
				g.Go(func() error {
					if s.Judge.MayPerform(gctx, id, authz.Attributes{Resource: "persistentvolumes", Verb: "get", Name: name}).Verdict != authz.Yes {
						note(name, "PV details unavailable: caller lacks get persistentvolumes permission")

						return nil
					}
					pv, err := s.Kubernetes.CoreV1().PersistentVolumes().Get(gctx, name, metav1.GetOptions{})
					if err != nil {
						note(name, err.Error())

						return nil
					}
					mu.Lock()
					pvs[name] = describePV(pv)
					mu.Unlock()

					return nil
				})
			}
			_ = g.Wait()
		}

		slices.SortFunc(claims, func(a, b Claim) int {
			if c := strings.Compare(a.Namespace, b.Namespace); c != 0 {
				return c
			}

			return strings.Compare(a.Name, b.Name)
		})
		byClaim := map[string]*Claim{}
		for i := range claims {
			byClaim[claims[i].Namespace+"/"+claims[i].Name] = &claims[i]
		}
		observedAt := s.now().UTC().Format("2006-01-02T15:04:05.000Z")
		sources := []MetricSource{}

		if s.PrometheusURL == "" {
			note("prometheus", "Prometheus is not configured; volume inventory is available without usage statistics")
		} else if len(claims) > 0 {
			selector := ""
			if namespace != "" {
				selector = "{namespace=" + promString(namespace) + "}"
			}
			sources = make([]MetricSource, len(volumeMetrics))
			g, gctx := errgroup.WithContext(ctx)
			for i, m := range volumeMetrics {
				sources[i] = MetricSource{Field: m.field, Metric: m.metric, Query: "max by (namespace,persistentvolumeclaim) (" + m.metric + selector + ")"}
				g.Go(func() error {
					values, warnings, err := s.vector(gctx, backend, sources[i].Query, observedAt)
					if err == nil && namespace != "" && slices.ContainsFunc(values, func(v Sample) bool { return v.Labels["namespace"] != namespace }) {
						err = errors.New("Prometheus returned volume metrics outside the requested namespace") //nolint:staticcheck // Prometheus is a proper noun.
					}
					if err != nil {
						sources[i].Error = err.Error()
						note(m.metric, err.Error())

						return nil
					}
					for _, w := range warnings {
						note(m.metric, w)
					}
					mu.Lock()
					defer mu.Unlock()
					for _, v := range values {
						claim := byClaim[v.Labels["namespace"]+"/"+v.Labels["persistentvolumeclaim"]]
						if claim == nil || v.Value < 0 {
							continue
						}
						value := v.Value
						switch m.field {
						case "usedBytes":
							claim.Usage.UsedBytes = &value
						case "capacityBytes":
							claim.Usage.CapacityBytes = &value
						case "inodes":
							claim.Usage.Inodes = &value
						case "inodesUsed":
							claim.Usage.InodesUsed = &value
						}
					}

					return nil
				})
			}
			_ = g.Wait()
		}

		list := slices.Collect(maps.Values(pvs))
		slices.SortFunc(list, func(a, b PersistentVolume) int { return strings.Compare(a.Name, b.Name) })
		slices.SortStableFunc(degraded, func(a, b VolumeDegraded) int { return strings.Compare(a.Source, b.Source) })
		result = &Volumes{
			ObservedAt: observedAt, Namespace: optional(namespace), Claims: claims, PersistentVolumes: orEmpty(list),
			MetricSources: sources, Degraded: degraded,
			Notes: []string{
				"PVC and PV inventory comes from the Kubernetes API. Bound PV details require get permission for that PV; includeUnboundPVs requires cluster-wide list PV permission.",
				"Requested and provisioned storage retain Kubernetes quantity units. Usage and capacity bytes, inode count and used inode count come from kubelet volume metrics, deduplicated by namespace and claim.",
				"Absent volume samples are null, not zero. Metrics may be unavailable for unmounted claims or unsupported volume modes/drivers. " +
					"Shared claim usage covers the volume as a whole. No CSI volume attributes or secret references are exported.",
			},
		}

		return nil
	})

	return result, err
}

// vector evaluates an instant query and returns finite samples.
func (s *Service) vector(ctx context.Context, backend Requester, query, at string) ([]Sample, []string, error) {
	u := endpoint(s.PrometheusURL, "/api/v1/query")
	v := u.Query()
	v.Set("query", query)
	v.Set("time", at)
	v.Set("limit", strconv.Itoa(maxSeries+1))
	u.RawQuery = v.Encode()
	var resp promResponse
	if err := get(ctx, backend, u, "Prometheus", &resp); err != nil {
		return nil, nil, err
	}
	if err := resp.check("vector"); err != nil {
		return nil, nil, err
	}
	if len(resp.Data.Result) > maxSeries {
		return nil, nil, errors.New("volume metrics exceeded the series limit")
	}
	var out []Sample
	for _, series := range resp.Data.Result {
		if series.Value == nil {
			continue
		}
		value, err := strconv.ParseFloat(series.Value.Value, 64)
		if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
			continue
		}
		out = append(out, Sample{Labels: series.Metric, Value: value})
	}

	return out, resp.Warnings, nil
}
