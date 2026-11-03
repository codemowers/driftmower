package provisioning

import (
	"reflect"
	"strings"
	"testing"

	"github.com/codemowers/driftmower/mcp/internal/authz"
)

// The sandbox-stack bundle, transcribed from its networkpolicy.yaml.
var sandboxNative = []NetworkPolicyInput{
	{Name: "default-deny-ingress", PodSelector: &LabelSelector{}, PolicyTypes: []string{"Ingress"}, Ingress: []any{}},
	{Name: "internal-ingress", PodSelector: &LabelSelector{}, PolicyTypes: []string{"Ingress"}, Ingress: []any{"from pods"}},
	{Name: "default-deny-egress", PodSelector: &LabelSelector{}, PolicyTypes: []string{"Egress"}, Egress: []any{}, HasEgress: true},
	{Name: "dns-egress", PodSelector: &LabelSelector{}, PolicyTypes: []string{"Egress"}, Egress: []any{"to namespaces"}, HasEgress: true},
	// Ingress on 8000 from the operator, hardcoded to the name "database".
	{Name: "cnpg-operator", PodSelector: &LabelSelector{MatchLabels: map[string]string{"cnpg.io/cluster": "database"}},
		PolicyTypes: []string{"Ingress"}, Ingress: []any{"from namespaces"}},
	// The apiserver egress policy is name-agnostic via Exists.
	{Name: "apiserver-egress-cnpg", PodSelector: &LabelSelector{MatchExpressions: []LabelSelectorRequirement{{Key: "cnpg.io/cluster", Operator: "Exists"}}},
		PolicyTypes: []string{"Egress"}, Egress: []any{"to ipBlock"}, HasEgress: true},
}

var sandboxCilium = []CiliumPolicyInput{
	{Name: "database-health-probes", EndpointSelector: &LabelSelector{MatchLabels: map[string]string{"cnpg.io/cluster": "database"}},
		IngressEntities: [][]string{{"host", "remote-node", "world"}}},
	{Name: "database-kube-apiserver", EndpointSelector: &LabelSelector{MatchLabels: map[string]string{"cnpg.io/cluster": "database"}},
		EgressEntities: [][]string{{"kube-apiserver"}}},
}

func TestDetectPosture(t *testing.T) {
	cases := []struct {
		name      string
		policies  []NetworkPolicyInput
		direction string
		want      NetworkPosture
	}{
		{"sandbox ingress", sandboxNative, "Ingress", DefaultDeny},
		{"sandbox egress", sandboxNative, "Egress", DefaultDeny},
		{"none ingress", nil, "Ingress", Open},
		{"none egress", nil, "Egress", Open},
		{"permits something", []NetworkPolicyInput{{Name: "a", PodSelector: &LabelSelector{}, PolicyTypes: []string{"Ingress"}, Ingress: []any{"x"}}}, "Ingress", Open},
		// Omitted policyTypes defaults to Ingress.
		{"implicit ingress", []NetworkPolicyInput{{Name: "a", PodSelector: &LabelSelector{}}}, "Ingress", DefaultDeny},
		{"implicit egress", []NetworkPolicyInput{{Name: "a", PodSelector: &LabelSelector{}}}, "Egress", Open},
		{"scoped", []NetworkPolicyInput{{Name: "a", PodSelector: &LabelSelector{MatchLabels: map[string]string{"app": "x"}},
			PolicyTypes: []string{"Ingress"}, Ingress: []any{}}}, "Ingress", Open},
	}
	for _, tc := range cases {
		if got := DetectPosture(tc.policies, tc.direction); got != tc.want {
			t.Errorf("%s: DetectPosture = %s, want %s", tc.name, got, tc.want)
		}
	}
}

// covers reports whether any selector admits direction for an instance name;
// a nil labelValue is name-agnostic.
func covers(selectors []PolicySelector, instance, direction string, predicate func(PolicySelector) bool) bool {
	for _, s := range selectors {
		if s.Direction == direction && (s.LabelValue == nil || *s.LabelValue == instance) && (predicate == nil || predicate(s)) {
			return true
		}
	}

	return false
}

func TestExtractSelectors(t *testing.T) {
	selectors := ExtractSelectors("cnpg.io/cluster", sandboxNative, sandboxCilium)
	find := func(policy string) *PolicySelector {
		for i := range selectors {
			if selectors[i].Policy == policy {
				return &selectors[i]
			}
		}

		return nil
	}

	if s := find("cnpg-operator"); s == nil || s.LabelValue == nil || *s.LabelValue != "database" {
		t.Errorf("cnpg-operator = %+v", s)
	}
	if s := find("apiserver-egress-cnpg"); s == nil || s.LabelValue != nil {
		t.Errorf("Exists selector = %+v", s)
	}
	if s := find("database-health-probes"); s == nil || s.Kind != "CiliumNetworkPolicy" || *s.LabelValue != "database" ||
		!strings.Contains(s.Admits, "host, remote-node, world") {
		t.Errorf("probes = %+v", s)
	}
	if find("default-deny-ingress") != nil || find("dns-egress") != nil {
		t.Error("policies without the label extracted")
	}

	// The trap: an instance not named database loses its probe ingress.
	if !covers(selectors, "database", "Ingress", nil) || covers(selectors, "orders-db", "Ingress", nil) ||
		!covers(selectors, "orders-db", "Egress", nil) {
		t.Error("coverage by instance name wrong")
	}
	nodeSourced := func(s PolicySelector) bool { return strings.Contains(s.Admits, "remote-node") }
	if !covers(selectors, "database", "Ingress", nodeSourced) || covers(selectors, "orders-db", "Ingress", nodeSourced) {
		t.Error("node-sourced coverage wrong")
	}
}

func TestComputeHeadroom(t *testing.T) {
	const gi, mi = 1 << 30, 1 << 20
	h := ComputeHeadroom(&ResourceQuotaInput{
		Name: "sandbox-quota",
		StatusHard: QuotaAmounts{"requests.cpu": "1", "requests.memory": "2Gi", "requests.storage": "10Gi",
			"persistentvolumeclaims": "5", "pods": "50"},
		StatusUsed: QuotaAmounts{"requests.cpu": "100m", "requests.memory": "1434Mi", "requests.storage": "3Gi",
			"persistentvolumeclaims": "1", "pods": "4"},
	})
	if *h.CPUMillis != 900 || *h.StorageBytes != 7*gi || *h.PVCCount != 4 || *h.Pods != 46 || *h.MemoryBytes != 2*gi-1434*mi {
		t.Errorf("headroom = cpu %d storage %v pvc %d pods %d memory %v", *h.CPUMillis, *h.StorageBytes, *h.PVCCount, *h.Pods, *h.MemoryBytes)
	}

	// A dimension the quota does not cap is unlimited, not zero.
	h = ComputeHeadroom(&ResourceQuotaInput{StatusHard: QuotaAmounts{"pods": "50"}, StatusUsed: QuotaAmounts{}})
	if *h.Pods != 50 || h.StorageBytes != nil || h.CPUMillis != nil {
		t.Errorf("uncapped = %+v", h)
	}

	h = ComputeHeadroom(&ResourceQuotaInput{StatusHard: QuotaAmounts{"requests.storage": "10Gi"}, StatusUsed: QuotaAmounts{"requests.storage": "12Gi"}})
	if *h.StorageBytes != 0 {
		t.Errorf("negative headroom = %v", *h.StorageBytes)
	}

	// Status wins over spec, because status is what is enforced.
	h = ComputeHeadroom(&ResourceQuotaInput{SpecHard: QuotaAmounts{"pods": "999"}, StatusHard: QuotaAmounts{"pods": "50"}, StatusUsed: QuotaAmounts{"pods": "1"}})
	if *h.Pods != 49 {
		t.Errorf("status vs spec = %d", *h.Pods)
	}

	if ComputeHeadroom(nil) != nil {
		t.Error("no quota produced headroom")
	}
}

func TestContainerDefaults(t *testing.T) {
	d := ContainerDefaults([][]LimitRangeItem{{{Type: "Container",
		DefaultRequest: QuotaAmounts{"cpu": "50m", "memory": "64Mi"}, Default: QuotaAmounts{"memory": "256Mi"}}}})
	if d == nil || d.Default["memory"] != "256Mi" || d.DefaultRequest["cpu"] != "50m" {
		t.Errorf("defaults = %+v", d)
	}
	if d := ContainerDefaults([][]LimitRangeItem{{{Type: "Pod", Default: QuotaAmounts{"memory": "1Gi"}}}}); d != nil {
		t.Errorf("Pod limit range = %+v", d)
	}
	if ContainerDefaults(nil) != nil {
		t.Error("empty")
	}
}

func allVerbs(v Verdict) map[Verb]Verdict {
	m := map[Verb]Verdict{}
	for _, verb := range Verbs {
		m[verb] = v
	}

	return m
}

func with(m map[Verb]Verdict, verb Verb, v Verdict) map[Verb]Verdict {
	m[verb] = v

	return m
}

var (
	yes, no, unknown = authz.Yes, authz.No, authz.Unknown

	testMatrix = map[string]map[Verb]Verdict{
		ResourceKey("", "pods"):                                  with(allVerbs(yes), "delete", no),
		ResourceKey("", "secrets"):                               allVerbs(yes),
		ResourceKey("apps", "deployments"):                       allVerbs(yes),
		ResourceKey("rbac.authorization.k8s.io", "rolebindings"): allVerbs(no),
		ResourceKey("postgresql.cnpg.io", "clusters"):            allVerbs(yes),
		ResourceKey("rabbitmq.com", "rabbitmqclusters"):          with(allVerbs(yes), "create", no),
		ResourceKey("s3.onyxia.sh", "buckets"):                   with(allVerbs(no), "create", unknown),
	}

	testTargets = []ProvisionTarget{
		{ID: Postgres, Resources: []TargetResource{{Group: "postgresql.cnpg.io", Resource: "clusters"}, {Group: "", Resource: "secrets"}}},
		{ID: RabbitMQ, Resources: []TargetResource{{Group: "rabbitmq.com", Resource: "rabbitmqclusters"}}},
		{ID: Bucket, Resources: []TargetResource{{Group: "s3.onyxia.sh", Resource: "buckets"}, {Group: "s3.onyxia.sh", Resource: "s3users"}}},
		{ID: EMQX, Resources: []TargetResource{{Group: "apps.emqx.io", Reason: "not served"}}},
	}
)

func TestSummariseMatrix(t *testing.T) {
	p := SummariseMatrix(testMatrix, nil)
	if p.View != yes || p.Edit != yes || p.Admin != no {
		t.Errorf("view/edit/admin = %s %s %s", p.View, p.Edit, p.Admin)
	}
	if p.Summary.ResourceTypes != 7 || p.Summary.ByVerb["create"] != 4 || p.Summary.ByVerb["delete"] != 4 || p.Summary.Unknown != 1 {
		t.Errorf("summary = %+v", p.Summary)
	}

	p = SummariseMatrix(testMatrix, testTargets)
	if !reflect.DeepEqual(p.Provision, map[OfferingID]Verdict{Postgres: yes, RabbitMQ: no, Bucket: unknown, EMQX: unknown}) {
		t.Errorf("provision = %+v", p.Provision)
	}
	want := []ProvisionRow{{Resource: "rabbitmqclusters.rabbitmq.com", Verdict: no, Reason: ptr("Kubernetes RBAC denies create rabbitmqclusters.rabbitmq.com")}}
	if !reflect.DeepEqual(p.ProvisionDetail[RabbitMQ], want) {
		t.Errorf("rabbitmq detail = %+v", p.ProvisionDetail[RabbitMQ])
	}
	// A resource missing from the matrix is unknown, never silently allowed.
	if rows := p.ProvisionDetail[Bucket]; len(rows) != 2 || rows[0].Verdict != unknown || rows[1].Verdict != unknown {
		t.Errorf("bucket detail = %+v", rows)
	}
	if r := p.ProvisionDetail[EMQX][0].Reason; r == nil || *r != "not served" {
		t.Errorf("emqx reason = %v", r)
	}
}

func TestComposeCreateVerdict(t *testing.T) {
	v := ComposeCreateVerdict(authz.Judgement{Verdict: yes}, []Denial{{Policy: "egress-guard", Messages: []string{"No.", "Really no"}}}, "networkpolicies", nil)
	if v.Verdict != no || !strings.Contains(v.Reason, "egress-guard") || !strings.Contains(v.Reason, "No. Really no") {
		t.Errorf("denial = %+v", v)
	}
	if v := ComposeCreateVerdict(authz.Judgement{Verdict: yes}, nil, "x", nil); v.Verdict != yes {
		t.Errorf("yes = %+v", v)
	}
	if v := ComposeCreateVerdict(authz.Judgement{Verdict: unknown, Reason: "webhook down"}, nil, "clusters.postgresql.cnpg.io", nil); !strings.Contains(v.Reason,
		"kubectl auth can-i create clusters.postgresql.cnpg.io") {
		t.Errorf("unknown = %+v", v)
	}

	constraints := []Denial{{Policy: "cnpg-replicas", Messages: []string{"spec.instances must be between 1 and 2."}}}
	allowed := ComposeCreateVerdict(authz.Judgement{Verdict: yes}, nil, "clusters.postgresql.cnpg.io", constraints)
	if allowed.Verdict != yes || allowed.Reason != "Kubernetes RBAC allows creating clusters.postgresql.cnpg.io. Enforced admission policies (cnpg-replicas) validate the manifest and reject an invalid one with an explanation." {
		t.Errorf("constrained = %+v", allowed)
	}
	if v := ComposeCreateVerdict(authz.Judgement{Verdict: unknown, Reason: "webhook down"}, nil, "x", constraints); !strings.Contains(v.Reason, "cnpg-replicas") {
		t.Errorf("unknown with constraints = %+v", v)
	}
	if v := ComposeCreateVerdict(authz.Judgement{Verdict: yes}, []Denial{{Policy: "legacy", Messages: []string{"no"}}}, "x", constraints); v.Verdict != no {
		t.Errorf("denial over constraints = %+v", v)
	}
}

func TestMayCreateVerdict(t *testing.T) {
	p := SummariseMatrix(testMatrix, testTargets)
	if v := MayCreateVerdict(&p, &testTargets[0], nil, "clusters.postgresql.cnpg.io", nil); v.Verdict != yes {
		t.Errorf("postgres = %+v", v)
	}
	if v := MayCreateVerdict(&p, &testTargets[1], nil, "rabbitmqclusters.rabbitmq.com", nil); v.Verdict != no || !strings.Contains(v.Reason, "rabbitmqclusters.rabbitmq.com") {
		t.Errorf("rabbitmq = %+v", v)
	}
	if v := MayCreateVerdict(&p, &testTargets[2], nil, "buckets.s3.onyxia.sh", nil); v.Verdict != unknown {
		t.Errorf("bucket = %+v", v)
	}
	if v := MayCreateVerdict(&p, &testTargets[0], []Denial{{Policy: "guard", Messages: []string{"nope"}}}, "x", nil); v.Verdict != no {
		t.Errorf("denied = %+v", v)
	}
	if v := MayCreateVerdict(nil, &testTargets[0], nil, "x", nil); v.Verdict != unknown || !strings.Contains(v.Reason, "no verified caller") {
		t.Errorf("no caller = %+v", v)
	}
	if v := MayCreateVerdict(&p, nil, nil, "x", nil); v.Verdict != unknown {
		t.Errorf("no target = %+v", v)
	}
	// Not served is unknown for that reason, not for a failed review.
	if v := MayCreateVerdict(&p, &testTargets[3], nil, "emqxes.apps.emqx.io", nil); v != (VerdictReason{Verdict: unknown, Reason: "not served"}) {
		t.Errorf("not served = %+v", v)
	}
}
