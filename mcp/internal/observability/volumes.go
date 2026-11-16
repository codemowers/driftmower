package observability

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"math"
	"slices"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/sync/errgroup"
	corev1 "k8s.io/api/core/v1"
	storagev1 "k8s.io/api/storage/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/kube"
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
	UID                string      `json:"uid"`
	Phase              *string     `json:"phase"`
	StorageClass       *string     `json:"storageClass"`
	RequestedStorage   *string     `json:"requestedStorage"`
	ProvisionedStorage *string     `json:"provisionedStorage"`
	VolumeMode         string      `json:"volumeMode"`
	AccessModes        []string    `json:"accessModes"`
	BoundVolume        *string     `json:"boundVolume"`
	Usage              VolumeUsage `json:"usage"`
	// The caller may patch this claim and its StorageClass allows expansion;
	// always false when volume expansion is disabled on this server.
	CanExpand bool `json:"canExpand"`
	// Running or pending Pods mounting the claim; empty when the caller may
	// not list Pods in its namespace.
	UsedBy []PodRef `json:"usedBy"`
}

type PodRef struct {
	Name string `json:"name"`
	UID  string `json:"uid"`
}

// StorageClassInfo describes a class the listed volumes use. Parameters
// naming CSI Secrets (csi.storage.k8s.io/*) are left out.
type StorageClassInfo struct {
	Name                 string            `json:"name"`
	Provisioner          string            `json:"provisioner"`
	Parameters           map[string]string `json:"parameters"`
	ReclaimPolicy        string            `json:"reclaimPolicy"`
	VolumeBindingMode    string            `json:"volumeBindingMode"`
	AllowVolumeExpansion bool              `json:"allowVolumeExpansion"`
	MountOptions         []string          `json:"mountOptions"`
}

type ClaimRef struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	UID       string `json:"uid,omitempty"`
}

type PersistentVolume struct {
	UID             string    `json:"uid"`
	Name            string    `json:"name"`
	Phase           *string   `json:"phase"`
	CapacityStorage *string   `json:"capacityStorage"`
	StorageClass    *string   `json:"storageClass"`
	VolumeMode      string    `json:"volumeMode"`
	AccessModes     []string  `json:"accessModes"`
	ReclaimPolicy   *string   `json:"reclaimPolicy"`
	CSIDriver       *string   `json:"csiDriver"`
	Claim           *ClaimRef `json:"claim"`
	// When the PV last changed phase, such as becoming Released.
	LastPhaseTransitionTime *string `json:"lastPhaseTransitionTime"`
	// Where the volume can be attached, from its required node affinity.
	Affinity *VolumeAffinity `json:"affinity"`
}

// VolumeAffinity is a PV's placement: pinned to nodes (local storage such as
// TopoLVM or OpenEBS) or to availability zones (cloud block storage).
type VolumeAffinity struct {
	// node or zone.
	Kind   string   `json:"kind"`
	Values []string `json:"values"`
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
	StorageClasses    []StorageClassInfo `json:"storageClasses"`
	MetricSources     []MetricSource     `json:"metricSources"`
	// Prometheus's public address for linking usage graphs; nil when unknown.
	PrometheusURL *string          `json:"prometheusUrl"`
	Degraded      []VolumeDegraded `json:"degraded"`
	Notes         []string         `json:"notes"`
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
		UID:  string(pv.UID),
		Name: pv.Name, Phase: optional(string(pv.Status.Phase)), CapacityStorage: quantity(pv.Spec.Capacity, corev1.ResourceStorage),
		StorageClass: optional(pv.Spec.StorageClassName), VolumeMode: volumeMode(pv.Spec.VolumeMode), AccessModes: modes(pv.Spec.AccessModes),
		ReclaimPolicy: optional(string(pv.Spec.PersistentVolumeReclaimPolicy)),
	}
	if pv.Spec.CSI != nil {
		out.CSIDriver = &pv.Spec.CSI.Driver
	}
	if ref := pv.Spec.ClaimRef; ref != nil {
		out.Claim = &ClaimRef{Namespace: ref.Namespace, Name: ref.Name, UID: string(ref.UID)}
	}
	out.Affinity = volumeAffinity(pv.Spec.NodeAffinity)
	if t := pv.Status.LastPhaseTransitionTime; t != nil {
		v := t.UTC().Format("2006-01-02T15:04:05Z")
		out.LastPhaseTransitionTime = &v
	}

	return out
}

// volumeAffinity reads zone keys (topology.kubernetes.io/zone and CSI
// variants such as topology.ebs.csi.aws.com/zone) and node keys
// (kubernetes.io/hostname, topology.topolvm.io/node, openebs.io/nodeid).
// Zones win when a term names both.
func volumeAffinity(a *corev1.VolumeNodeAffinity) *VolumeAffinity {
	if a == nil || a.Required == nil {
		return nil
	}
	values := map[string][]string{}
	for _, term := range a.Required.NodeSelectorTerms {
		for _, e := range term.MatchExpressions {
			if e.Operator != corev1.NodeSelectorOpIn {
				continue
			}
			kind := ""
			switch {
			case strings.HasSuffix(e.Key, "/zone"):
				kind = "zone"
			case e.Key == corev1.LabelHostname || strings.HasSuffix(e.Key, "/node") || strings.HasSuffix(e.Key, "/nodeid"):
				kind = "node"
			}
			if kind != "" {
				for _, v := range e.Values {
					if !slices.Contains(values[kind], v) {
						values[kind] = append(values[kind], v)
					}
				}
			}
		}
	}
	for _, kind := range []string{"zone", "node"} {
		if len(values[kind]) > 0 {
			slices.Sort(values[kind])

			return &VolumeAffinity{Kind: kind, Values: values[kind]}
		}
	}

	return nil
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
	err := func(backend Requester) error {
		if s.Judge.MayPerform(ctx, id, authz.Attributes{Namespace: namespace, Resource: "persistentvolumeclaims", Verb: "list"}).Verdict != authz.Yes {
			if namespace != "" {
				return fmt.Errorf("Kubernetes RBAC denied list persistentvolumeclaims in namespace %s", namespace) //nolint:staticcheck // Kubernetes is a proper noun.
			}

			return errors.New("Kubernetes RBAC denied cluster-wide list persistentvolumeclaims; specify a namespace for scoped access") //nolint:staticcheck // Kubernetes is a proper noun.
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
				Namespace: c.Namespace, Name: c.Name, UID: string(c.UID), Phase: optional(string(c.Status.Phase)), StorageClass: c.Spec.StorageClassName,
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

		classes, err := s.Kubernetes.StorageV1().StorageClasses().List(ctx, metav1.ListOptions{})
		if err != nil {
			note("storageclasses", "StorageClasses are unavailable: "+err.Error())
			classes = &storagev1.StorageClassList{}
		}
		if s.ExpandEnabled && len(claims) > 0 {
			s.markExpandable(ctx, id, claims, classes.Items)
		}
		s.markUsedBy(ctx, id, namespace, claims, note)

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
		var prometheusURL *string

		if s.PrometheusURL == "" {
			note("prometheus", "Prometheus is not configured; volume inventory is available without usage statistics")
		} else if len(claims) > 0 {
			prometheusURL = s.externalURL(ctx, backend)
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
		used := map[string]bool{}
		for _, c := range claims {
			if c.StorageClass != nil {
				used[*c.StorageClass] = true
			}
		}
		for _, pv := range list {
			if pv.StorageClass != nil {
				used[*pv.StorageClass] = true
			}
		}
		storageClasses := []StorageClassInfo{}
		for _, c := range classes.Items {
			if used[c.Name] {
				storageClasses = append(storageClasses, describeStorageClass(&c))
			}
		}
		slices.SortStableFunc(degraded, func(a, b VolumeDegraded) int { return strings.Compare(a.Source, b.Source) })
		result = &Volumes{
			ObservedAt: observedAt, Namespace: optional(namespace), Claims: claims, PersistentVolumes: orEmpty(list), StorageClasses: storageClasses,
			MetricSources: sources, PrometheusURL: prometheusURL, Degraded: degraded,
			Notes: []string{
				"PVC and PV inventory comes from the Kubernetes API. Bound PV details require get permission for that PV; includeUnboundPVs requires cluster-wide list PV permission.",
				"Requested and provisioned storage retain Kubernetes quantity units. Usage and capacity bytes, inode count and used inode count come from kubelet volume metrics, deduplicated by namespace and claim.",
				"Absent volume samples are null, not zero. Metrics may be unavailable for unmounted claims or unsupported volume modes/drivers. " +
					"Shared claim usage covers the volume as a whole. No CSI volume attributes or secret references are exported.",
			},
		}

		return nil
	}(s.Backend)

	return result, err
}

// markExpandable sets CanExpand on Bound filesystem or block claims whose
// StorageClass allows expansion and which the caller may patch.
func (s *Service) markExpandable(ctx context.Context, id authz.Identity, claims []Claim, classes []storagev1.StorageClass) {
	expandable := map[string]bool{}
	for _, c := range classes {
		expandable[c.Name] = c.AllowVolumeExpansion != nil && *c.AllowVolumeExpansion
	}
	mayPatch := map[string]bool{}
	for i := range claims {
		c := &claims[i]
		if c.StorageClass == nil || !expandable[*c.StorageClass] || c.Phase == nil || *c.Phase != string(corev1.ClaimBound) {
			continue
		}
		allowed, seen := mayPatch[c.Namespace]
		if !seen {
			allowed = s.Judge.MayPerform(ctx, id, authz.Attributes{Namespace: c.Namespace, Resource: "persistentvolumeclaims", Verb: "patch"}).Verdict == authz.Yes
			mayPatch[c.Namespace] = allowed
		}
		c.CanExpand = allowed
	}
}

// markUsedBy lists the running or pending Pods mounting each claim, in
// namespaces where the caller may list Pods.
func (s *Service) markUsedBy(ctx context.Context, id authz.Identity, namespace string, claims []Claim, note func(source, message string)) {
	for i := range claims {
		claims[i].UsedBy = []PodRef{}
	}
	if len(claims) == 0 {
		return
	}
	var pods []corev1.Pod
	collect := func(ns string) error {
		items, err := kube.Collect(ctx, func(ctx context.Context, o metav1.ListOptions) ([]corev1.Pod, string, error) {
			l, err := s.Kubernetes.CoreV1().Pods(ns).List(ctx, o)
			if err != nil {
				return nil, "", err
			}

			return l.Items, l.Continue, nil
		}, kube.ListOptions{Limit: 500, MaxPages: 20, What: "Pod listing"})
		pods = append(pods, items...)

		return err
	}
	if s.Judge.MayPerform(ctx, id, authz.Attributes{Namespace: namespace, Resource: "pods", Verb: "list"}).Verdict == authz.Yes {
		if err := collect(namespace); err != nil {
			note("pods", "Pods using claims are unavailable: "+err.Error())

			return
		}
	} else {
		seen := map[string]bool{}
		for _, c := range claims {
			if seen[c.Namespace] {
				continue
			}
			seen[c.Namespace] = true
			if s.Judge.MayPerform(ctx, id, authz.Attributes{Namespace: c.Namespace, Resource: "pods", Verb: "list"}).Verdict != authz.Yes {
				note("pods", c.Namespace+": Pods using claims are unavailable: caller lacks list pods permission")
				continue
			}
			if err := collect(c.Namespace); err != nil {
				note("pods", c.Namespace+": Pods using claims are unavailable: "+err.Error())
			}
		}
	}
	byClaim := map[string]int{}
	for i, c := range claims {
		byClaim[c.Namespace+"/"+c.Name] = i
	}
	for _, p := range pods {
		if p.Status.Phase == corev1.PodSucceeded || p.Status.Phase == corev1.PodFailed {
			continue
		}
		for _, v := range p.Spec.Volumes {
			if v.PersistentVolumeClaim == nil {
				continue
			}
			if i, ok := byClaim[p.Namespace+"/"+v.PersistentVolumeClaim.ClaimName]; ok {
				claims[i].UsedBy = append(claims[i].UsedBy, PodRef{Name: p.Name, UID: string(p.UID)})
			}
		}
	}
	for i := range claims {
		slices.SortFunc(claims[i].UsedBy, func(a, b PodRef) int { return strings.Compare(a.Name, b.Name) })
	}
}

func describeStorageClass(c *storagev1.StorageClass) StorageClassInfo {
	params := map[string]string{}
	for k, v := range c.Parameters {
		if !strings.HasPrefix(k, "csi.storage.k8s.io/") {
			params[k] = v
		}
	}
	out := StorageClassInfo{Name: c.Name, Provisioner: c.Provisioner, Parameters: params, ReclaimPolicy: "Delete", VolumeBindingMode: "Immediate",
		AllowVolumeExpansion: c.AllowVolumeExpansion != nil && *c.AllowVolumeExpansion, MountOptions: orEmpty(c.MountOptions)}
	if c.ReclaimPolicy != nil {
		out.ReclaimPolicy = string(*c.ReclaimPolicy)
	}
	if c.VolumeBindingMode != nil {
		out.VolumeBindingMode = string(*c.VolumeBindingMode)
	}

	return out
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
