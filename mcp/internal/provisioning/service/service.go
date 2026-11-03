// Package service is the provisioning capability layer: cluster facts read
// natively, per-namespace facts confined to what the caller may see, and every
// permission answer asked of the cluster authorizer as the verified caller.
//
// Every result is either ok or a named unavailability. The degraded list
// travels with ok results untouched: a fact that could not be read must never
// arrive looking like a fact that was read and came back empty.
package service

import (
	"context"
	"fmt"
	"regexp"
	"slices"
	"strings"

	"golang.org/x/sync/errgroup"

	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/provisioning"
	"github.com/codemowers/driftmower/mcp/internal/provisioning/facts"
)

// Unavailable reports that the Kubernetes API could not be read.
type Unavailable struct {
	Status string `json:"status"`
	Reason string `json:"reason"`
	Detail string `json:"detail"`
}

func unavailable(err error) *Unavailable {
	return &Unavailable{Status: "unavailable", Reason: "kubernetes_unreachable", Detail: "The Kubernetes API could not be read: " + err.Error()}
}

type Service struct {
	facts *facts.Facts
	judge authz.Judge
	// Upper bound on namespaces per call.
	MaxNamespaces int
	// Namespaces gathered at once; defaults to 4.
	Concurrency int
}

func New(f *facts.Facts, judge authz.Judge, maxNamespaces int) *Service {
	return &Service{facts: f, judge: judge, MaxNamespaces: maxNamespaces}
}

// Invalidate drops cached cluster facts.
func (s *Service) Invalidate() {
	s.facts.Invalidate()
}

// Capabilities is the response of the JSON route, plus the namespaces whose
// facts were withheld.
type Capabilities struct {
	provisioning.CapabilityResponse
	Withheld []string `json:"withheld"`
}

// ErrTooManyNamespaces is returned when a request names more namespaces than
// the configured bound.
type ErrTooManyNamespaces struct{ Max int }

func (e ErrTooManyNamespaces) Error() string {
	return fmt.Sprintf("At most %d namespaces per call (PROVISIONING_MAX_NAMESPACES)", e.Max)
}

// Capabilities is the one code path behind the JSON route and every tool.
func (s *Service) Capabilities(ctx context.Context, id *authz.Identity, namespaces []string, offering provisioning.OfferingID) (*Capabilities, error) {
	cluster, err := s.facts.Cluster(ctx)
	if err != nil {
		return nil, err
	}
	requested := normalise(namespaces)
	if len(requested) > s.MaxNamespaces {
		return nil, ErrTooManyNamespaces{Max: s.MaxNamespaces}
	}

	var spec *provisioning.OfferingSpec
	var target *provisioning.ProvisionTarget
	if o, ok := provisioning.OfferingByID(offering); ok {
		spec = &o
		for i := range cluster.Targets {
			if cluster.Targets[i].ID == o.ID {
				target = &cluster.Targets[i]
			}
		}
	}

	results := make([]facts.NamespaceResult, len(requested))
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(max(1, s.Concurrency, 4))
	for i, ns := range requested {
		g.Go(func() (err error) {
			in := facts.NamespaceInput{Namespace: ns, Identity: id, Target: target}
			if spec != nil {
				in.OfferingLabelKey = spec.InstanceLabelKey
			}
			results[i], err = s.facts.Namespace(gctx, in)

			return err
		})
	}
	if err := g.Wait(); err != nil {
		return nil, err
	}

	degraded := slices.Clone(cluster.Degraded)
	out := &Capabilities{Withheld: []string{}}
	nsFacts := []provisioning.NamespaceFact{}
	hostRules := []provisioning.HostRule{}
	for _, r := range results {
		view := authz.Yes
		if r.Fact.Access != nil {
			view = r.Fact.Access.View
		}
		// Facts about a namespace the caller may not see are withheld, and
		// the reason travels in degraded when it was inconclusive.
		if id != nil && view != authz.Yes {
			out.Withheld = append(out.Withheld, r.Fact.Namespace)
			if view == authz.Unknown {
				degraded = record(degraded, provisioning.DegradedRead{Source: "subjectaccessreviews", Status: 0,
					Message: "Access to " + r.Fact.Namespace + " could not be evaluated by the cluster authorizer; its facts are withheld, not absent."})
			}

			continue
		}
		nsFacts = append(nsFacts, r.Fact)
		for _, d := range r.Degraded {
			degraded = record(degraded, d)
		}
		hostRules = append(hostRules, hostRuleFrom(cluster, r.Fact, r.Labels, r.Annotations, id))
	}

	out.CapabilityResponse = provisioning.CapabilityResponse{
		InCluster:         true,
		Offerings:         cluster.Offerings,
		StorageClasses:    cluster.StorageClasses,
		Topology:          cluster.Topology,
		Namespaces:        nsFacts,
		Policies:          cluster.Policies,
		AdmissionPolicies: cluster.AdmissionPolicies,
		Ingress: provisioning.IngressFact{
			Classes:        cluster.Ingress.Classes,
			ClusterIssuers: cluster.Ingress.ClusterIssuers,
			TLSAdvice:      cluster.Ingress.TLSAdvice,
			HostRules:      hostRules,
		},
		PriorityClasses:     cluster.PriorityClasses,
		NetworkPolicyEngine: cluster.NetworkPolicyEngine,
		MonitoringOperator:  cluster.MonitoringOperator,
		Degraded:            degraded,
	}
	if s := cluster.Ingress.DomainSuffix; s != nil {
		out.Ingress.DomainSuffix, out.Ingress.DomainSuffixSource = &s.Value, &s.Source
	}

	return out, nil
}

func normalise(namespaces []string) []string {
	out := []string{}
	for _, n := range namespaces {
		if n = strings.TrimSpace(n); n != "" && !slices.Contains(out, n) {
			out = append(out, n)
		}
	}

	return out
}

// record keeps one row per fact family, not per namespace: the fix is the
// same rule.
func record(degraded []provisioning.DegradedRead, d provisioning.DegradedRead) []provisioning.DegradedRead {
	if slices.ContainsFunc(degraded, func(e provisioning.DegradedRead) bool { return e.Source == d.Source }) {
		return degraded
	}

	return append(degraded, d)
}

// PlatformIngress is the ingress fact without per-namespace host rules.
type PlatformIngress struct {
	DomainSuffix       *string                         `json:"domainSuffix"`
	DomainSuffixSource *string                         `json:"domainSuffixSource"`
	Classes            []provisioning.IngressClassFact `json:"classes"`
	ClusterIssuers     []string                        `json:"clusterIssuers"`
	TLSAdvice          string                          `json:"tlsAdvice"`
}

type Platform struct {
	Status              string                           `json:"status"`
	StorageClasses      []provisioning.StorageClassFact  `json:"storageClasses"`
	Topology            provisioning.TopologyFact        `json:"topology"`
	PriorityClasses     []provisioning.PriorityClassFact `json:"priorityClasses"`
	NetworkPolicyEngine string                           `json:"networkPolicyEngine"`
	MonitoringOperator  bool                             `json:"monitoringOperator"`
	Ingress             PlatformIngress                  `json:"ingress"`
	Policies            []provisioning.PolicyFact        `json:"policies"`
	AdmissionPolicies   []provisioning.AdmissionFact     `json:"admissionPolicies"`
	TenantLabelKey      *string                          `json:"tenantLabelKey"`
	OfferingsReady      int                              `json:"offeringsReady"`
	OfferingsTotal      int                              `json:"offeringsTotal"`
	Degraded            []provisioning.DegradedRead      `json:"degraded"`
}

func (s *Service) DescribePlatform(ctx context.Context) (*Platform, *Unavailable) {
	cluster, err := s.facts.Cluster(ctx)
	if err != nil {
		return nil, unavailable(err)
	}
	ready := 0
	for _, o := range cluster.Offerings {
		if o.Availability.State == provisioning.StateReady {
			ready++
		}
	}
	p := &Platform{
		Status:              "ok",
		StorageClasses:      cluster.StorageClasses,
		Topology:            cluster.Topology,
		PriorityClasses:     cluster.PriorityClasses,
		NetworkPolicyEngine: cluster.NetworkPolicyEngine,
		MonitoringOperator:  cluster.MonitoringOperator,
		Ingress: PlatformIngress{
			Classes:        cluster.Ingress.Classes,
			ClusterIssuers: cluster.Ingress.ClusterIssuers,
			TLSAdvice:      cluster.Ingress.TLSAdvice,
		},
		Policies:          cluster.Policies,
		AdmissionPolicies: cluster.AdmissionPolicies,
		OfferingsReady:    ready,
		OfferingsTotal:    len(cluster.Offerings),
		Degraded:          cluster.Degraded,
	}
	if cluster.TenantLabelKey != "" {
		p.TenantLabelKey = &cluster.TenantLabelKey
	}
	if s := cluster.Ingress.DomainSuffix; s != nil {
		p.Ingress.DomainSuffix, p.Ingress.DomainSuffixSource = &s.Value, &s.Source
	}

	return p, nil
}

type Offerings struct {
	Status    string                      `json:"status"`
	Offerings []provisioning.OfferingCard `json:"offerings"`
	// Set when a namespace was asked about and the caller may not see it.
	Withheld []string                    `json:"withheld"`
	Degraded []provisioning.DegradedRead `json:"degraded"`
}

func (s *Service) ListOfferings(ctx context.Context, id *authz.Identity, offering provisioning.OfferingID, namespace string) (*Offerings, *Unavailable) {
	var namespaces []string
	if namespace != "" {
		namespaces = []string{namespace}
	}
	resp, err := s.Capabilities(ctx, id, namespaces, "")
	if err != nil {
		return nil, unavailable(err)
	}
	cards := []provisioning.OfferingCard{}
	for _, c := range resp.Offerings {
		if offering != "" && c.ID != offering {
			continue
		}
		if len(resp.Namespaces) > 0 {
			c = withVerdict(c, resp.Namespaces[0])
		}
		cards = append(cards, c)
	}

	return &Offerings{Status: "ok", Offerings: cards, Withheld: resp.Withheld, Degraded: resp.Degraded}, nil
}

// withVerdict attaches the namespace's composed verdict for this offering:
// RBAC across everything it creates, with enforced admission applied.
func withVerdict(c provisioning.OfferingCard, ns provisioning.NamespaceFact) provisioning.OfferingCard {
	if v, ok := ns.Offerings[c.ID]; ok {
		c.MayCreate, c.MayCreateReason = &v.Verdict, v.Reason

		return c
	}
	unknown := authz.Unknown
	c.MayCreate, c.MayCreateReason = &unknown, "This offering was not checked here."

	return c
}

type Readiness struct {
	Status     string                       `json:"status"`
	Requested  []string                     `json:"requested"`
	Namespaces []provisioning.NamespaceFact `json:"namespaces"`
	HostRules  []provisioning.HostRule      `json:"hostRules"`
	// Requested namespaces whose facts were not returned because the
	// authorizer does not let the caller list pods there, or could not say.
	Withheld []string                    `json:"withheld"`
	Degraded []provisioning.DegradedRead `json:"degraded"`
}

func (s *Service) DescribeNamespaceReadiness(ctx context.Context, id *authz.Identity, namespaces []string, offering provisioning.OfferingID) (*Readiness, *Unavailable) {
	requested := normalise(namespaces)
	resp, err := s.Capabilities(ctx, id, requested, offering)
	if err != nil {
		return nil, unavailable(err)
	}

	return &Readiness{Status: "ok", Requested: requested, Namespaces: resp.Namespaces, HostRules: resp.Ingress.HostRules,
		Withheld: resp.Withheld, Degraded: resp.Degraded}, nil
}

type AccessCheckInput struct {
	Namespace   string `json:"namespace,omitempty"`
	Verb        string `json:"verb"`
	Group       string `json:"group"`
	Resource    string `json:"resource"`
	Subresource string `json:"subresource,omitempty"`
	Name        string `json:"name,omitempty"`
}

type RBACVerdict struct {
	Verdict provisioning.Verdict `json:"verdict"`
	Reason  *string              `json:"reason"`
}

type PolicyName struct {
	Policy string `json:"policy"`
}

type AccessCheck struct {
	Status    string                `json:"status"`
	Verdict   provisioning.Verdict  `json:"verdict"`
	Reason    string                `json:"reason"`
	RBAC      RBACVerdict           `json:"rbac"`
	Admission []provisioning.Denial `json:"admission"`
	// Enforced policies that only shape the object: the operation is allowed
	// if the manifest meets them.
	AdmissionConstraints []PolicyName `json:"admissionConstraints"`
	// Mutating policies that rewrite the object on CREATE or UPDATE.
	AdmissionDefaults []provisioning.AdmissionDefault `json:"admissionDefaults"`
	Identity          *authz.Identity                 `json:"identity"`
}

// CheckAccess answers the exact question for anything the matrix does not
// cover: cluster-scoped resources, subresources, named objects, proxy.
func (s *Service) CheckAccess(ctx context.Context, id *authz.Identity, in AccessCheckInput) (*AccessCheck, *Unavailable) {
	cluster, err := s.facts.Cluster(ctx)
	if err != nil {
		return nil, unavailable(err)
	}
	what := in.Resource
	if in.Subresource != "" {
		what += "/" + in.Subresource
	}
	group := in.Group
	if group == "" {
		group = "core"
	}
	what += "." + group
	operation := strings.ToUpper(in.Verb)
	admits := operation == "CREATE" || operation == "UPDATE" || operation == "DELETE"

	labels := map[string]string{}
	if in.Namespace != "" && admits {
		r, err := s.facts.Namespace(ctx, facts.NamespaceInput{Namespace: in.Namespace})
		if err != nil {
			return nil, unavailable(err)
		}
		labels = r.Labels
	}
	denials, constraints := []provisioning.Denial{}, []provisioning.Denial{}
	if admits {
		var groups []string
		if id != nil {
			groups = id.Groups
		}
		denials, constraints = provisioning.AdmissionFor(cluster.Admission, provisioning.DenialCheck{
			Operation:       provisioning.Operation{Group: in.Group, Resource: in.Resource, Operation: operation},
			NamespaceLabels: labels,
			CallerGroups:    groups,
		})
	}
	defaults := []provisioning.AdmissionDefault{}
	if operation == "CREATE" || operation == "UPDATE" {
		resource := in.Resource
		if in.Subresource != "" {
			resource += "/" + in.Subresource
		}
		defaults = provisioning.MutationsOf(cluster.Mutations, provisioning.Operation{Group: in.Group, Resource: resource, Operation: operation})
	}
	names := make([]PolicyName, len(constraints))
	for i, c := range constraints {
		names[i] = PolicyName{Policy: c.Policy}
	}

	result := &AccessCheck{Status: "ok", Admission: denials, AdmissionConstraints: names, AdmissionDefaults: defaults, Identity: id}
	if id == nil {
		result.Verdict = authz.Unknown
		result.Reason = "The call carried no verified caller, so permission was not checked. Run `kubectl auth can-i " + in.Verb + " " + what + "`."
		result.RBAC = RBACVerdict{Verdict: authz.Unknown, Reason: ptr("no verified caller")}

		return result, nil
	}

	rbac := s.judge.MayPerform(ctx, *id, authz.Attributes{
		Namespace: in.Namespace, Verb: in.Verb, Group: in.Group, Resource: in.Resource, Subresource: in.Subresource, Name: in.Name,
	})
	result.RBAC = RBACVerdict{Verdict: rbac.Verdict}
	if rbac.Reason != "" {
		result.RBAC.Reason = &rbac.Reason
	}

	switch {
	case operation == "CREATE":
		v := provisioning.ComposeCreateVerdict(rbac, denials, what, constraints)
		result.Verdict, result.Reason = v.Verdict, v.Reason
	case len(denials) > 0:
		result.Verdict = authz.No
		result.Reason = "An enforced admission policy (" + denials[0].Policy + ") governs " + in.Verb + " on " + what + ": " + strings.Join(denials[0].Messages, ". ")
	case rbac.Verdict == authz.Yes:
		result.Verdict = authz.Yes
		result.Reason = "Kubernetes RBAC allows " + in.Verb + " on " + what + "."
		if len(constraints) > 0 {
			result.Reason += " " + provisioning.ConstraintSentence(constraints)
		}
	default:
		result.Verdict = rbac.Verdict
		result.Reason = rbac.Reason
		if result.Reason == "" {
			result.Reason = "The access review could not be evaluated"
		}
	}

	return result, nil
}

func ptr[T any](v T) *T { return &v }

var hostMention = regexp.MustCompile(`(?i)host`)

// hostRuleFrom derives the hostname a namespace may claim. Only an enforced
// ingress guard that scopes on a tenant label yields a pattern; anything else
// gets an honest note rather than a fabricated rule.
func hostRuleFrom(cluster *facts.Cluster, fact provisioning.NamespaceFact, labels, annotations map[string]string, id *authz.Identity) provisioning.HostRule {
	suffix := cluster.Ingress.DomainSuffix
	var groups []string
	if id != nil {
		groups = id.Groups
	}
	// The host guard shapes Ingresses rather than forbidding them, so
	// whichever way its effect reads, it is the policy the host rule comes
	// from.
	denials, constraints := provisioning.AdmissionFor(cluster.Admission, provisioning.DenialCheck{
		Operation:       provisioning.Operation{Group: "networking.k8s.io", Resource: "ingresses", Operation: "CREATE"},
		NamespaceLabels: labels,
		CallerGroups:    groups,
	})
	mentionsHost := func(d provisioning.Denial) bool { return slices.ContainsFunc(d.Messages, hostMention.MatchString) }
	var guard *provisioning.Denial
	if len(denials) > 0 {
		guard = &denials[0]
	} else if i := slices.IndexFunc(constraints, mentionsHost); i >= 0 {
		guard = &constraints[i]
	}

	var tenantID *string
	if fact.Tenant != nil {
		tenantID = &fact.Tenant.ID
	}
	rule := provisioning.HostRule{Namespace: fact.Namespace, TenantID: tenantID, SandboxID: tenantID, CustomDomains: []string{}}
	if guard != nil {
		rule.EnforcedBy = &guard.Policy
		// The message about hosts, not one about another resource the guard
		// also covers.
		if i := slices.IndexFunc(guard.Messages, hostMention.MatchString); i >= 0 {
			rule.EnforcedMessage = &guard.Messages[i]
		} else if len(guard.Messages) > 0 {
			rule.EnforcedMessage = &guard.Messages[0]
		}
	}

	switch {
	case suffix == nil:
		rule.Note = "This cluster publishes no ingress domain, so ask the platform team which hostnames you may use."

		return rule
	case guard == nil:
		rule.Note = "No admission policy enforces a hostname pattern on this namespace; hostnames under " + suffix.Value + " are a convention, not a rule."

		return rule
	case tenantID == nil:
		rule.Note = "The " + guard.Policy + " admission policy governs Ingress creation here, but this namespace carries no tenant label it scopes on; its message is reported as-is."

		return rule
	}

	// What the guard's own CEL reads decides the shape: anchored on the
	// namespace or on the tenant id, and whether verified custom domains count.
	var policy *provisioning.AdmissionPolicyFact
	for i := range cluster.Admission {
		if cluster.Admission[i].Name == guard.Policy {
			policy = &cluster.Admission[i]
		}
	}
	customDomains := []string{}
	anchors := false
	if policy != nil {
		anchors = policy.AnchorsOnNamespace
		if slices.Contains(policy.NamespaceAnnotationKeys, provisioning.VerifiedDomainsAnnotation) {
			customDomains = provisioning.ParseCustomDomains(annotations[provisioning.VerifiedDomainsAnnotation])
		}
	}
	r := provisioning.HostRuleFor(suffix.Value, *tenantID, guard.Policy, fact.Namespace, anchors, customDomains)
	rule.ExactHost, rule.LabelledPattern, rule.CustomDomains = &r.ExactHost, &r.LabelledPattern, customDomains

	anchor := "tenant-id prefix"
	if r.AnchorsOnNamespace {
		anchor = "namespace anchor"
	}
	rule.Note = "Only these hostnames are accepted here, and the " + guard.Policy + " admission policy enforces it: the ingress controller is shared, and the " +
		anchor + " is what keeps one tenant from claiming another's traffic."
	if len(customDomains) > 0 {
		rule.Note += " Names under " + strings.Join(customDomains, ", ") + " are accepted too: custom domains verified for this namespace's owners. " +
			"Point each such hostname at the cluster with a CNAME to " + r.ExactHost + " (a bare domain needs the DNS provider's " +
			"ALIAS/ANAME or CNAME flattening, not A records), write the full hostname in the Ingress, and give it a certificate as the TLS advice says."
	}
	if suffix.Source == "config" {
		rule.Note += " The domain comes from this server's configuration rather than from the guard's own parameters, so confirm it before relying on it."
	}

	return rule
}
