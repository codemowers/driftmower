package facts

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"golang.org/x/sync/errgroup"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/kube"
	"github.com/codemowers/driftmower/mcp/internal/provisioning"
)

// Matrix builds the access matrix: one SubjectAccessReview per namespaced
// resource type and verb, as the verified caller. A plain loop with no
// shortcuts: every cell is the authorizer's own answer, and the review cache
// is what makes a repeat call free. Subresources are left to check_access.
func (f *Facts) Matrix(ctx context.Context, id authz.Identity, namespace string) (map[string]map[provisioning.Verb]provisioning.Verdict, error) {
	surface, err := f.surface.Get(ctx)
	if err != nil {
		return nil, err
	}
	type target struct{ group, resource string }
	seen := map[string]bool{}
	var targets []target
	for _, r := range surface.ByKind {
		key := provisioning.ResourceKey(r.Group, r.Plural)
		if r.Namespaced && !seen[key] {
			seen[key] = true
			targets = append(targets, target{r.Group, r.Plural})
		}
	}
	slices.SortFunc(targets, func(a, b target) int {
		return strings.Compare(provisioning.ResourceKey(a.group, a.resource), provisioning.ResourceKey(b.group, b.resource))
	})

	verdicts := make([]provisioning.Verdict, len(targets)*len(provisioning.Verbs))
	concurrency := f.opts.MatrixConcurrency
	if concurrency <= 0 {
		concurrency = 16
	}
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(concurrency)
	for i, t := range targets {
		for j, verb := range provisioning.Verbs {
			g.Go(func() error {
				verdicts[i*len(provisioning.Verbs)+j] = f.opts.Judge.MayPerform(gctx, id, authz.Attributes{
					Namespace: namespace, Group: t.group, Resource: t.resource, Verb: string(verb),
				}).Verdict

				return nil
			})
		}
	}
	_ = g.Wait()
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	matrix := make(map[string]map[provisioning.Verb]provisioning.Verdict, len(targets))
	for i, t := range targets {
		row := make(map[provisioning.Verb]provisioning.Verdict, len(provisioning.Verbs))
		for j, verb := range provisioning.Verbs {
			row[verb] = verdicts[i*len(provisioning.Verbs)+j]
		}
		matrix[provisioning.ResourceKey(t.group, t.resource)] = row
	}

	return matrix, nil
}

// NamespaceInput asks for one namespace's facts.
type NamespaceInput struct {
	Namespace string
	// Nil when the call was unauthenticated; no access matrix is built then.
	Identity *authz.Identity
	// The label an offering's own pods carry. Network coverage is only
	// meaningful relative to one offering.
	OfferingLabelKey string
	// The offering asked about; nil when none.
	Target *provisioning.ProvisionTarget
}

type NamespaceResult struct {
	Fact        provisioning.NamespaceFact
	Labels      map[string]string
	Annotations map[string]string
	Degraded    []provisioning.DegradedRead
}

var ciliumPolicies = schema.GroupVersionResource{Group: "cilium.io", Version: "v2", Resource: "ciliumnetworkpolicies"}

type ciliumPolicy struct {
	Metadata struct {
		Name string `json:"name"`
	} `json:"metadata"`
	Spec struct {
		EndpointSelector *provisioning.LabelSelector `json:"endpointSelector"`
		Ingress          []struct {
			FromEntities []string `json:"fromEntities"`
		} `json:"ingress"`
		Egress []struct {
			ToEntities []string `json:"toEntities"`
		} `json:"egress"`
	} `json:"spec"`
}

// Namespace gathers one namespace's facts. They are deliberately not cached:
// quota headroom must be fresh, or a plan is green-lit that the API server
// has just started rejecting.
func (f *Facts) Namespace(ctx context.Context, in NamespaceInput) (NamespaceResult, error) {
	cluster, err := f.Cluster(ctx)
	if err != nil {
		return NamespaceResult{}, err
	}
	k := f.opts.Kubernetes
	ns := in.Namespace

	var (
		quotas                                  *corev1.ResourceQuotaList
		limits                                  *corev1.LimitRangeList
		native                                  *networkingv1.NetworkPolicyList
		cilium                                  []ciliumPolicy
		namespace                               *corev1.Namespace
		quotasU, limitsU, nativeU, ciliumU, nsU *unknown
		matrix                                  map[string]map[provisioning.Verb]provisioning.Verdict
		registries                              []provisioning.RegistryFact
		registryDegraded                        degradedList
	)
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() (err error) {
		quotas, err = k.CoreV1().ResourceQuotas(ns).List(gctx, metav1.ListOptions{})
		quotasU, err = tolerate("resourcequotas", err)

		return err
	})
	g.Go(func() (err error) {
		limits, err = k.CoreV1().LimitRanges(ns).List(gctx, metav1.ListOptions{})
		limitsU, err = tolerate("limitranges", err)

		return err
	})
	g.Go(func() (err error) {
		native, err = k.NetworkingV1().NetworkPolicies(ns).List(gctx, metav1.ListOptions{})
		nativeU, err = tolerate("networkpolicies", err)

		return err
	})
	g.Go(func() (err error) {
		cilium, err = kube.ListUnstructured[ciliumPolicy](gctx, f.opts.Dynamic, ciliumPolicies, ns, kube.ListOptions{})
		ciliumU, err = tolerate("ciliumnetworkpolicies", err)

		return err
	})
	g.Go(func() (err error) {
		namespace, err = k.CoreV1().Namespaces().Get(gctx, ns, metav1.GetOptions{})
		nsU, err = tolerate("namespaces", err)

		return err
	})
	if in.Identity != nil {
		g.Go(func() (err error) { matrix, err = f.Matrix(gctx, *in.Identity, ns); return err })
	}
	g.Go(func() (err error) {
		registries, err = f.loadRegistries(gctx, ns, cluster, &registryDegraded)
		return err
	})
	if err := g.Wait(); err != nil {
		return NamespaceResult{}, err
	}

	var degraded degradedList
	degraded.note("resourcequotas", quotasU)
	degraded.note("limitranges", limitsU)
	degraded.note("networkpolicies", nativeU)
	degraded.note("ciliumnetworkpolicies", ciliumU)
	degraded.note("namespaces", nsU)
	degraded = append(degraded, registryDegraded...)

	labels, annotations := map[string]string{}, map[string]string{}
	if nsU == nil {
		labels = orEmptyMap(namespace.Labels)
		annotations = orEmptyMap(namespace.Annotations)
	}

	var nativeInputs []provisioning.NetworkPolicyInput
	if nativeU == nil {
		for _, p := range native.Items {
			in := provisioning.NetworkPolicyInput{Name: p.Name, PodSelector: selectorOf(p.Spec.PodSelector), HasEgress: p.Spec.Egress != nil}
			for _, t := range p.Spec.PolicyTypes {
				in.PolicyTypes = append(in.PolicyTypes, string(t))
			}
			for range p.Spec.Ingress {
				in.Ingress = append(in.Ingress, struct{}{})
			}
			for range p.Spec.Egress {
				in.Egress = append(in.Egress, struct{}{})
			}
			nativeInputs = append(nativeInputs, in)
		}
	}
	var ciliumInputs []provisioning.CiliumPolicyInput
	for _, p := range cilium {
		in := provisioning.CiliumPolicyInput{Name: p.Metadata.Name, EndpointSelector: p.Spec.EndpointSelector}
		for _, r := range p.Spec.Ingress {
			in.IngressEntities = append(in.IngressEntities, r.FromEntities)
		}
		for _, r := range p.Spec.Egress {
			in.EgressEntities = append(in.EgressEntities, r.ToEntities)
		}
		ciliumInputs = append(ciliumInputs, in)
	}

	// Several quotas can apply at once; the first is enough for headroom.
	var quota *provisioning.ResourceQuotaInput
	var quotaFact *provisioning.Quota
	if quotasU == nil && len(quotas.Items) > 0 {
		q := quotas.Items[0]
		quota = &provisioning.ResourceQuotaInput{Name: q.Name, StatusHard: amounts(q.Status.Hard), StatusUsed: amounts(q.Status.Used), SpecHard: amounts(q.Spec.Hard)}
		hard := quota.StatusHard
		if hard == nil {
			hard = orEmptyMap(quota.SpecHard)
		}
		quotaFact = &provisioning.Quota{Name: orUnnamed(q.Name), Used: orEmptyMap(quota.StatusUsed), Hard: hard}
	}
	var limitItems [][]provisioning.LimitRangeItem
	if limitsU == nil {
		for _, l := range limits.Items {
			var items []provisioning.LimitRangeItem
			for _, item := range l.Spec.Limits {
				items = append(items, provisioning.LimitRangeItem{Type: string(item.Type), DefaultRequest: amounts(item.DefaultRequest), Default: amounts(item.Default)})
			}
			limitItems = append(limitItems, items)
		}
	}

	selectors := []provisioning.PolicySelector{}
	if in.OfferingLabelKey != "" {
		selectors = provisioning.ExtractSelectors(in.OfferingLabelKey, nativeInputs, ciliumInputs)
	}

	var tenantID string
	if cluster.TenantLabelKey != "" {
		tenantID = labels[cluster.TenantLabelKey]
	}
	var access *provisioning.AccessProfile
	if matrix != nil {
		profile := provisioning.SummariseMatrix(matrix, cluster.Targets)
		access = &profile
	}
	var callerGroups []string
	if in.Identity != nil {
		callerGroups = in.Identity.Groups
	}
	verdictFor := func(t *provisioning.ProvisionTarget) provisioning.VerdictReason {
		what := "this"
		denials, constraints := []provisioning.Denial{}, []provisioning.Denial{}
		if t != nil {
			what = "the " + string(t.ID) + " resource"
			if p := t.Resources[0]; p.Resource != "" {
				what = p.Resource + "." + p.Group
				denials, constraints = provisioning.AdmissionFor(cluster.Admission, provisioning.DenialCheck{
					Operation:       provisioning.Operation{Group: p.Group, Resource: p.Resource, Version: p.Version, Operation: "CREATE"},
					NamespaceLabels: labels,
					CallerGroups:    callerGroups,
				})
			}
		}

		return provisioning.MayCreateVerdict(access, t, denials, what, constraints)
	}

	permission := verdictFor(in.Target)
	offerings := map[provisioning.OfferingID]provisioning.VerdictReason{}
	for i := range cluster.Targets {
		offerings[cluster.Targets[i].ID] = verdictFor(&cluster.Targets[i])
	}
	if access != nil && access.Summary.Unknown > 0 {
		degraded = append(degraded, provisioning.DegradedRead{Source: "subjectaccessreviews", Status: 0,
			Message: fmt.Sprintf("%d access review(s) for %s could not be evaluated; those cells are unknown, not denied.", access.Summary.Unknown, ns)})
	}

	ingressPosture, egressPosture := provisioning.UnknownPosture, provisioning.UnknownPosture
	if nativeU == nil {
		ingressPosture = provisioning.DetectPosture(nativeInputs, "Ingress")
		egressPosture = provisioning.DetectPosture(nativeInputs, "Egress")
	}

	fact := provisioning.NamespaceFact{
		Namespace:  ns,
		Sandbox:    strOrNil(tenantID),
		Quota:      quotaFact,
		Headroom:   provisioning.ComputeHeadroom(quota),
		LimitRange: provisioning.ContainerDefaults(limitItems),
		Network: provisioning.NetworkFact{
			Ingress: ingressPosture, Egress: egressPosture, Selectors: selectors, CiliumAvailable: ciliumU == nil,
		},
		Access:          access,
		MayCreate:       permission.Verdict,
		MayCreateReason: permission.Reason,
		Offerings:       offerings,
		Registries:      registries,
		PodSecurity:     provisioning.PodSecurityFor(labels),
	}
	if cluster.TenantLabelKey != "" && tenantID != "" {
		fact.Tenant = &provisioning.Tenant{LabelKey: cluster.TenantLabelKey, ID: tenantID}
	}

	return NamespaceResult{Fact: fact, Labels: labels, Annotations: annotations, Degraded: orEmpty([]provisioning.DegradedRead(degraded))}, nil
}

// loadRegistries reads Services and Ingresses only once a Deployment here
// runs Zot, so a namespace without a registry costs one listing.
func (f *Facts) loadRegistries(ctx context.Context, ns string, cluster *Cluster, degraded *degradedList) ([]provisioning.RegistryFact, error) {
	k := f.opts.Kubernetes
	deployments, err := k.AppsV1().Deployments(ns).List(ctx, metav1.ListOptions{})
	u, err := tolerate("deployments", err)
	if err != nil {
		return nil, err
	}
	degraded.note("deployments", u)
	if u != nil {
		return []provisioning.RegistryFact{}, nil
	}
	var zot []provisioning.RegistryDeployment
	for _, d := range deployments.Items {
		rd := provisioning.RegistryDeployment{Name: d.Name, PodLabels: d.Spec.Template.Labels}
		for _, c := range d.Spec.Template.Spec.Containers {
			rd.Images = append(rd.Images, c.Image)
		}
		if slices.ContainsFunc(rd.Images, provisioning.IsZotImage) {
			zot = append(zot, rd)
		}
	}
	if len(zot) == 0 {
		return []provisioning.RegistryFact{}, nil
	}

	services, err := k.CoreV1().Services(ns).List(ctx, metav1.ListOptions{})
	servicesU, err := tolerate("services", err)
	if err != nil {
		return nil, err
	}
	ingresses, err := k.NetworkingV1().Ingresses(ns).List(ctx, metav1.ListOptions{})
	ingressesU, err := tolerate("ingresses", err)
	if err != nil {
		return nil, err
	}
	degraded.note("services", servicesU)
	degraded.note("ingresses", ingressesU)
	if servicesU != nil || ingressesU != nil {
		return []provisioning.RegistryFact{}, nil
	}

	var svcs []provisioning.RegistryService
	for _, s := range services.Items {
		svcs = append(svcs, provisioning.RegistryService{Name: s.Name, Selector: s.Spec.Selector})
	}
	var ings []provisioning.RegistryIngress
	for _, i := range ingresses.Items {
		ri := provisioning.RegistryIngress{Name: i.Name}
		for _, tls := range i.Spec.TLS {
			ri.TLSHosts = append(ri.TLSHosts, tls.Hosts...)
		}
		for _, rule := range i.Spec.Rules {
			ir := provisioning.IngressRuleInput{Host: rule.Host}
			if rule.HTTP != nil {
				for _, p := range rule.HTTP.Paths {
					if p.Backend.Service != nil {
						ir.Services = append(ir.Services, p.Backend.Service.Name)
					}
				}
			}
			ri.Rules = append(ri.Rules, ir)
		}
		ings = append(ings, ri)
	}

	found := provisioning.FindRegistries(zot, svcs, ings)
	var clusterID *string
	if f.opts.ClusterID != nil {
		clusterID = f.opts.ClusterID()
	}
	for i := range found {
		found[i].SkaffoldEnv = provisioning.SkaffoldEnvFor(provisioning.KubeContextFor(clusterID, ns), found[i].Host, ns)
	}

	return found, nil
}

func selectorOf(s metav1.LabelSelector) *provisioning.LabelSelector {
	out := &provisioning.LabelSelector{MatchLabels: s.MatchLabels}
	for _, e := range s.MatchExpressions {
		out.MatchExpressions = append(out.MatchExpressions, provisioning.LabelSelectorRequirement{Key: e.Key, Operator: string(e.Operator), Values: e.Values})
	}

	return out
}

func amounts(list corev1.ResourceList) provisioning.QuotaAmounts {
	if list == nil {
		return nil
	}
	out := make(provisioning.QuotaAmounts, len(list))
	for k, v := range list {
		out[string(k)] = v.String()
	}

	return out
}

func orEmptyMap[M ~map[string]string](m M) M {
	if m == nil {
		return M{}
	}

	return m
}

func orUnnamed(name string) string {
	if name == "" {
		return "(unnamed)"
	}

	return name
}

func strOrNil(s string) *string {
	if s == "" {
		return nil
	}

	return &s
}
