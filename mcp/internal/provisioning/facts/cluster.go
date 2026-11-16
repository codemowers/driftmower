package facts

import (
	"context"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"golang.org/x/sync/errgroup"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"

	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/catalog"
	"github.com/codemowers/driftmower/mcp/internal/kube"
	"github.com/codemowers/driftmower/mcp/internal/provisioning"
	"github.com/codemowers/driftmower/mcp/internal/ttlcache"
)

// DomainSuffix is the ingress domain and where it came from: "guard-params"
// is what admission enforces; "config" is not verified against any policy.
type DomainSuffix struct {
	Value  string
	Source string
}

type IngressFacts struct {
	DomainSuffix   *DomainSuffix
	Classes        []provisioning.IngressClassFact
	ClusterIssuers []string
	TLSAdvice      string
}

// Cluster holds the cluster-wide facts.
type Cluster struct {
	Surface   *kube.APISurface
	Offerings []provisioning.OfferingCard
	// Per offering, the resources its sample creates, in Offerings order.
	Targets           []provisioning.ProvisionTarget
	StorageClasses    []provisioning.StorageClassFact
	Topology          provisioning.TopologyFact
	Policies          []provisioning.PolicyFact
	Admission         []provisioning.AdmissionPolicyFact
	Mutations         []provisioning.MutationFact
	AdmissionPolicies []provisioning.AdmissionFact
	TenantLabelKey    string
	Ingress           IngressFacts
	PriorityClasses   []provisioning.PriorityClassFact
	// cilium, native or none.
	NetworkPolicyEngine string
	MonitoringOperator  bool
	Degraded            []provisioning.DegradedRead
}

// Options configure fact gathering.
type Options struct {
	Kubernetes kubernetes.Interface
	Dynamic    dynamic.Interface
	Catalog    *catalog.Catalog
	Judge      authz.Judge
	// Fallback ingress domain when no admission guard publishes one.
	IngressDomainSuffix string
	ClusterFactTTL      time.Duration
	TopologyTTL         time.Duration
	OperatorTTL         time.Duration
	// Reviews in flight while building an access matrix; defaults to 16.
	MatrixConcurrency int
	// Read per call: the identity is discovered after these facts are built.
	ClusterID func() *string
}

// Facts gathers provisioning facts. Cluster-wide facts are memoised and
// invalidated by the CRD watch or their TTLs; namespace facts are never
// cached, because quota headroom must be fresh.
type Facts struct {
	opts      Options
	surface   *ttlcache.Memo[*kube.APISurface]
	topology  *ttlcache.Memo[topologyResult]
	operators *ttlcache.Memo[operatorsResult]
	cluster   *ttlcache.Memo[*Cluster]
}

func (f *Facts) CacheStats() map[string]ttlcache.Stats {
	return map[string]ttlcache.Stats{"api_surface": f.surface.Stats(), "topology": f.topology.Stats(), "operators": f.operators.Stats(), "cluster_facts": f.cluster.Stats()}
}

type topologyResult struct {
	fact    provisioning.TopologyFact
	unknown *unknown
}

type operatorsResult struct {
	items   []appsv1.Deployment
	unknown *unknown
}

func New(opts Options) *Facts {
	f := &Facts{opts: opts}
	f.surface = ttlcache.NewMemo(opts.ClusterFactTTL, func(context.Context) (*kube.APISurface, error) {
		return kube.LoadAPISurface(opts.Kubernetes.Discovery())
	}, nil)
	f.topology = ttlcache.NewMemo(opts.TopologyTTL, f.loadTopology, nil)
	f.operators = ttlcache.NewMemo(opts.OperatorTTL, f.loadOperators, nil)
	f.cluster = ttlcache.NewMemo(opts.ClusterFactTTL, f.gather, nil)

	return f
}

func (f *Facts) Cluster(ctx context.Context) (*Cluster, error) {
	return f.cluster.Get(ctx)
}

func (f *Facts) Surface(ctx context.Context) (*kube.APISurface, error) {
	return f.surface.Get(ctx)
}

// Invalidate drops every cached cluster fact.
func (f *Facts) Invalidate() {
	f.surface.Invalidate()
	f.topology.Invalidate()
	f.operators.Invalidate()
	f.cluster.Invalidate()
}

// Node objects are large, so they page in small batches.
func (f *Facts) loadTopology(ctx context.Context) (topologyResult, error) {
	nodes, err := kube.Collect(ctx, func(ctx context.Context, lo metav1.ListOptions) ([]provisioning.Node, string, error) {
		list, err := f.opts.Kubernetes.CoreV1().Nodes().List(ctx, lo)
		if err != nil {
			return nil, "", err
		}
		out := make([]provisioning.Node, 0, len(list.Items))
		for _, n := range list.Items {
			node := provisioning.Node{Labels: n.Labels, Unschedulable: n.Spec.Unschedulable, Allocatable: map[string]string{}}
			for _, t := range n.Spec.Taints {
				node.TaintEffects = append(node.TaintEffects, string(t.Effect))
			}
			for _, c := range n.Status.Conditions {
				if c.Type == corev1.NodeReady && c.Status == corev1.ConditionTrue {
					node.Ready = true
				}
			}
			for k, v := range n.Status.Allocatable {
				node.Allocatable[string(k)] = v.String()
			}
			out = append(out, node)
		}

		return out, list.Continue, nil
	}, kube.ListOptions{Limit: 50, MaxPages: 200, What: "Node listing"})
	u, err := tolerate("nodes", err)
	if err != nil {
		return topologyResult{}, err
	}
	if u != nil {
		return topologyResult{fact: provisioning.TopologyFact{Zones: []provisioning.ZoneFact{}}, unknown: u}, nil
	}

	return topologyResult{fact: provisioning.ToTopologyFact(nodes)}, nil
}

func (f *Facts) loadOperators(ctx context.Context) (operatorsResult, error) {
	items, err := kube.Collect(ctx, func(ctx context.Context, lo metav1.ListOptions) ([]appsv1.Deployment, string, error) {
		list, err := f.opts.Kubernetes.AppsV1().Deployments("").List(ctx, lo)
		if err != nil {
			return nil, "", err
		}

		return list.Items, list.Continue, nil
	}, kube.ListOptions{Limit: 200, MaxPages: 100, What: "Deployment listing"})
	u, err := tolerate("deployments", err)
	if err != nil {
		return operatorsResult{}, err
	}

	return operatorsResult{items: items, unknown: u}, nil
}

var kyvernoPolicies = schema.GroupVersionResource{Group: "kyverno.io", Version: "v1", Resource: "clusterpolicies"}

type kyvernoMatch struct {
	Resources *struct {
		Kinds []string `json:"kinds"`
	} `json:"resources"`
}

type kyvernoPolicy struct {
	Metadata struct {
		Name string `json:"name"`
	} `json:"metadata"`
	Spec struct {
		ValidationFailureAction string `json:"validationFailureAction"`
		Rules                   []struct {
			Match struct {
				kyvernoMatch
				Any []kyvernoMatch `json:"any"`
			} `json:"match"`
		} `json:"rules"`
	} `json:"spec"`
}

// loadKyvernoPolicies reports a cluster without Kyverno as absent, a fact
// rather than a failure.
func (f *Facts) loadKyvernoPolicies(ctx context.Context) ([]provisioning.PolicyFact, *unknown, error) {
	items, err := kube.ListUnstructured[kyvernoPolicy](ctx, f.opts.Dynamic, kyvernoPolicies, "", kube.ListOptions{})
	if u, err := tolerate("kyverno clusterpolicies", err); u != nil || err != nil {
		return []provisioning.PolicyFact{}, u, err
	}
	out := []provisioning.PolicyFact{}
	for _, p := range items {
		if p.Metadata.Name == "" {
			continue
		}
		var touches []string
		for _, r := range p.Spec.Rules {
			if r.Match.Resources != nil {
				touches = append(touches, r.Match.Resources.Kinds...)
			}
			for _, a := range r.Match.Any {
				if a.Resources != nil {
					touches = append(touches, a.Resources.Kinds...)
				}
			}
		}
		// Only Enforce can reject an apply; Audit merely reports.
		fact := provisioning.PolicyFact{Engine: "kyverno", Name: p.Metadata.Name, Mode: "Audit", Touches: uniq(touches),
			Meaning: "This policy only reports; it will not block the apply."}
		if p.Spec.ValidationFailureAction == "Enforce" {
			fact.Mode = "Enforce"
			fact.Meaning = "This policy can reject the apply. A server-side dry run is what tells you for certain."
		}
		out = append(out, fact)
	}
	slices.SortFunc(out, func(a, b provisioning.PolicyFact) int {
		return strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name))
	})

	return out, nil, nil
}

func uniq(items []string) []string {
	out := []string{}
	for _, i := range items {
		if !slices.Contains(out, i) {
			out = append(out, i)
		}
	}

	return out
}

func (f *Facts) gather(ctx context.Context) (*Cluster, error) {
	var (
		surface    *kube.APISurface
		storage    []provisioning.StorageClassFact
		storageU   *unknown
		topology   topologyResult
		policies   []provisioning.PolicyFact
		policiesU  *unknown
		operators  operatorsResult
		admission  catalog.AdmissionPolicies
		admissionU *unknown
	)
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() (err error) { surface, err = f.surface.Get(gctx); return err })
	g.Go(func() error {
		classes, err := f.opts.Catalog.StorageClasses(gctx)
		if storageU, err = tolerate("storageclasses", err); storageU != nil || err != nil {
			return err
		}
		for _, c := range classes {
			in := provisioning.StorageClassInput{Name: c.Name, AllowExpansion: c.AllowVolumeExpansion, IsDefault: c.IsDefault, Description: c.Description}
			if c.Provisioner != nil {
				in.Provisioner = *c.Provisioner
			}
			if c.ReclaimPolicy != nil {
				in.ReclaimPolicy = *c.ReclaimPolicy
			}
			if c.VolumeBindingMode != nil {
				in.VolumeBindingMode = *c.VolumeBindingMode
			}
			if fact, ok := provisioning.ToStorageClassFact(in); ok {
				storage = append(storage, fact)
			}
		}
		slices.SortStableFunc(storage, func(a, b provisioning.StorageClassFact) int {
			if a.IsDefault != b.IsDefault {
				if a.IsDefault {
					return -1
				}

				return 1
			}

			return strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name))
		})

		return nil
	})
	g.Go(func() (err error) { topology, err = f.topology.Get(gctx); return err })
	g.Go(func() (err error) { policies, policiesU, err = f.loadKyvernoPolicies(gctx); return err })
	g.Go(func() (err error) { operators, err = f.operators.Get(gctx); return err })
	g.Go(func() (err error) {
		admission, err = f.opts.Catalog.AdmissionPolicies(gctx)
		admissionU, err = tolerate("validatingadmissionpolicies", err)

		return err
	})
	if err := g.Wait(); err != nil {
		return nil, err
	}

	issuerVersion := ""
	if versions := surface.VersionsByGroup["cert-manager.io"]; len(versions) > 0 {
		issuerVersion = versions[0]
	}
	platform := f.opts.Catalog.PlatformClasses(ctx, issuerVersion, "")
	var validating []provisioning.AdmissionPolicyFact
	var mutating []provisioning.MutationFact
	if admissionU == nil {
		validating, mutating = admission.Facts()
	}
	suffix, suffixDegraded, err := f.loadIngressSuffix(ctx, validating)
	if err != nil {
		return nil, err
	}

	var degraded degradedList
	degraded.note("storageclasses", storageU)
	degraded.note("nodes", topology.unknown)
	degraded.note("kyverno clusterpolicies", policiesU)
	degraded.note("deployments", operators.unknown)
	degraded.note("validatingadmissionpolicies", admissionU)
	degraded = append(degraded, suffixDegraded...)
	for _, d := range platform.Degraded {
		degraded = append(degraded, provisioning.DegradedRead{Source: d.Source, Status: 0, Message: d.Message})
	}

	lookup := func(provisioning.OperatorRef) *provisioning.OperatorHealth { return nil }
	if operators.unknown == nil {
		lookup = operatorHealthLookup(operators.items)
	}
	type entry struct {
		card   provisioning.OfferingCard
		target provisioning.ProvisionTarget
	}
	entries := make([]entry, 0, len(provisioning.Offerings))
	for _, spec := range provisioning.Offerings {
		card, target := toCard(spec, surface, lookup, mutating)
		entries = append(entries, entry{card, target})
	}
	// Installed offerings first, so a not-installed catalog sinks below the
	// usable one rather than burying it.
	slices.SortStableFunc(entries, func(a, b entry) int {
		if d := rank(a.card) - rank(b.card); d != 0 {
			return d
		}

		return strings.Compare(strings.ToLower(a.card.Name), strings.ToLower(b.card.Name))
	})

	issuers := make([]provisioning.IssuerFact, 0, len(platform.ClusterIssuers))
	issuerNames := []string{}
	for _, i := range platform.ClusterIssuers {
		fact := provisioning.IssuerFact{Name: i.Name, Ready: i.Ready}
		if i.ACME != nil {
			fact.ACME = &provisioning.ACMESolvers{HTTP01: i.ACME.HTTP01, DNS01: i.ACME.DNS01}
		}
		issuers = append(issuers, fact)
		issuerNames = append(issuerNames, i.Name)
	}
	classes := []provisioning.IngressClassFact{}
	for _, c := range platform.IngressClasses {
		classes = append(classes, provisioning.IngressClassFact{Name: c.Name, Controller: c.Controller, IsDefault: c.IsDefault})
	}
	priorities := []provisioning.PriorityClassFact{}
	for _, p := range platform.PriorityClasses {
		priorities = append(priorities, provisioning.PriorityClassFact{Name: p.Name, Value: p.Value, IsDefault: p.IsDefault, Meaning: priorityMeaning(p)})
	}

	c := &Cluster{
		Surface:           surface,
		StorageClasses:    orEmpty(storage),
		Topology:          topology.fact,
		Policies:          policies,
		Admission:         orEmpty(validating),
		Mutations:         orEmpty(mutating),
		AdmissionPolicies: []provisioning.AdmissionFact{},
		TenantLabelKey:    provisioning.TenantLabelKeyFor(validating),
		Ingress: IngressFacts{
			DomainSuffix:   suffix,
			Classes:        classes,
			ClusterIssuers: issuerNames,
			TLSAdvice:      provisioning.TLSAdvice(issuers),
		},
		PriorityClasses: priorities,
		// Cilium owns policy where its CRDs exist, because only entity-based
		// rules can admit node-sourced traffic such as CNPG's health probes.
		NetworkPolicyEngine: "none",
		MonitoringOperator:  surface.ServesGroup("monitoring.coreos.com"),
		Degraded:            orEmpty([]provisioning.DegradedRead(degraded)),
	}
	switch {
	case surface.ServesGroup("cilium.io"):
		c.NetworkPolicyEngine = "cilium"
	case surface.ServesGroup("networking.k8s.io"):
		c.NetworkPolicyEngine = "native"
	}
	for _, e := range entries {
		c.Offerings = append(c.Offerings, e.card)
		c.Targets = append(c.Targets, e.target)
	}
	for _, a := range validating {
		c.AdmissionPolicies = append(c.AdmissionPolicies, a.Projection())
	}

	return c, nil
}

func orEmpty[T any](items []T) []T {
	if items == nil {
		return []T{}
	}

	return items
}

// loadIngressSuffix reads a parameterised ingress guard's ConfigMap, only
// where the binding says it lives. A configured suffix is the fallback, and
// its provenance is reported.
func (f *Facts) loadIngressSuffix(ctx context.Context, admission []provisioning.AdmissionPolicyFact) (*DomainSuffix, []provisioning.DegradedRead, error) {
	var degraded degradedList
	for _, a := range admission {
		if !a.Enforced || a.ParamRef == nil || a.ParamRef.Namespace == nil ||
			!slices.ContainsFunc(a.Guards, func(g provisioning.GuardedOperation) bool { return g.Resource == "ingresses" }) {
			continue
		}
		cm, err := f.opts.Kubernetes.CoreV1().ConfigMaps(*a.ParamRef.Namespace).Get(ctx, a.ParamRef.Name, metav1.GetOptions{})
		u, err := tolerate("configmaps", err)
		if err != nil {
			return nil, nil, err
		}
		if u == nil {
			if v := provisioning.SuffixFromParams(cm.Data); v != "" {
				return &DomainSuffix{Value: v, Source: "guard-params"}, nil, nil
			}
		}
		degraded.note("configmaps", u)

		break
	}
	if f.opts.IngressDomainSuffix != "" {
		return &DomainSuffix{Value: f.opts.IngressDomainSuffix, Source: "config"}, degraded, nil
	}

	return nil, degraded, nil
}

var watchFlag = regexp.MustCompile(`^--(?:watch-namespaces?|namespaces?)=(.*)$`)

// operatorHealthLookup finds an offering's controller in any namespace: by
// exact name, by name prefix (Helm prepends the release name) or by carrying
// every one of the reference's labels.
func operatorHealthLookup(items []appsv1.Deployment) func(provisioning.OperatorRef) *provisioning.OperatorHealth {
	return func(ref provisioning.OperatorRef) *provisioning.OperatorHealth {
		for _, d := range items {
			byLabels := len(ref.Labels) > 0
			for k, v := range ref.Labels {
				if d.Labels[k] != v {
					byLabels = false
				}
			}
			if d.Name != ref.Deployment && !strings.HasPrefix(d.Name, ref.Deployment+"-") && !byLabels {
				continue
			}
			desired := int32(1)
			if d.Spec.Replicas != nil {
				desired = *d.Spec.Replicas
			}
			namespace := d.Namespace
			if namespace == "" {
				namespace = "(unknown)"
			}

			return &provisioning.OperatorHealth{
				Deployment:        d.Name,
				Namespace:         namespace,
				ReadyReplicas:     d.Status.ReadyReplicas,
				DesiredReplicas:   desired,
				Version:           operatorVersion(d),
				WatchedNamespaces: watchedNamespaces(d),
			}
		}

		return nil
	}
}

func operatorVersion(d appsv1.Deployment) *string {
	for _, label := range []string{"app.kubernetes.io/version", "helm.sh/chart"} {
		if v := d.Labels[label]; v != "" {
			return &v
		}
	}
	// Fall back to the image tag, which is what a user would read off the pod.
	if len(d.Spec.Template.Spec.Containers) > 0 {
		image, _, _ := strings.Cut(d.Spec.Template.Spec.Containers[0].Image, "@")
		if _, tag, ok := strings.Cut(image[strings.LastIndex(image, "/")+1:], ":"); ok {
			return &tag
		}
	}

	return nil
}

// watchedNamespaces reads a watch-scope flag, so no promise is made that an
// operator acts on a namespace it does not watch.
func watchedNamespaces(d appsv1.Deployment) provisioning.WatchedNamespaces {
	if len(d.Spec.Template.Spec.Containers) == 0 {
		return provisioning.WatchedNamespaces{All: true}
	}
	for _, arg := range d.Spec.Template.Spec.Containers[0].Args {
		m := watchFlag.FindStringSubmatch(arg)
		if m == nil {
			continue
		}
		value := strings.TrimSpace(m[1])
		if value == "" || value == "*" {
			return provisioning.WatchedNamespaces{All: true}
		}
		names := []string{}
		for n := range strings.SplitSeq(value, ",") {
			if n = strings.TrimSpace(n); n != "" {
				names = append(names, n)
			}
		}

		return provisioning.WatchedNamespaces{Names: names}
	}

	return provisioning.WatchedNamespaces{All: true}
}

func toCard(spec provisioning.OfferingSpec, surface *kube.APISurface, lookup func(provisioning.OperatorRef) *provisioning.OperatorHealth,
	mutations []provisioning.MutationFact) (provisioning.OfferingCard, provisioning.ProvisionTarget) {
	served, ok := surface.NegotiateVersion(spec.Group, spec.Kind, spec.Versions)
	primary := provisioning.TargetResource{Group: spec.Group,
		Reason: fmt.Sprintf("The cluster does not serve %s.%s, so there is nothing to create yet", spec.Kind, spec.Group)}
	if ok {
		primary = provisioning.TargetResource{Group: spec.Group, Resource: served.Plural, Version: served.Version}
	}
	target := provisioning.ProvisionTarget{ID: spec.ID, Resources: []provisioning.TargetResource{primary}}
	for _, r := range spec.AlsoRequires {
		target.Resources = append(target.Resources, provisioning.TargetResource{Group: r.Group, Resource: r.Resource})
	}

	operator := spec.Operator
	card := provisioning.OfferingCard{
		ID:                spec.ID,
		Name:              spec.Name,
		Purpose:           spec.Purpose,
		What:              spec.What,
		GoodFor:           spec.GoodFor,
		Operator:          &operator,
		Availability:      provisioning.AvailabilityOf(ok, lookup(spec.OperatorRef), &operator.DocsHref),
		Presets:           spec.Presets,
		Needs:             spec.Needs,
		AdmissionDefaults: provisioning.DefaultsFor(mutations, target),
	}
	if ok {
		card.Resource = ptr(served.Plural + "." + spec.Group)
		card.APIVersion = ptr(spec.Group + "/" + served.Version)
	}

	return card, target
}

func ptr[T any](v T) *T { return &v }

func rank(c provisioning.OfferingCard) int {
	switch c.Availability.State {
	case provisioning.StateReady:
		return 0
	case provisioning.StateDegraded:
		return 1
	case provisioning.StateCRDsOnly:
		return 2
	default:
		return 3
	}
}

func priorityMeaning(p catalog.PriorityClass) string {
	if p.IsDefault {
		return "Applied automatically when a pod names no priority class."
	}
	if p.Description != nil && strings.TrimSpace(*p.Description) != "" {
		return strings.TrimSpace(*p.Description)
	}

	return "Pods with a higher value are scheduled first and evict lower-priority pods when the cluster is full."
}
