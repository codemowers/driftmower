package provisioning

import (
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// The real guards, from platform-manager/deploy/{egress,sandbox}-guard.yaml.
var egressGuard = AdmissionPolicy{
	Name: "sandbox-egress-guard",
	ResourceRules: []ResourceRule{{APIGroups: []string{"networking.k8s.io"}, APIVersions: []string{"v1"},
		Operations: []string{"CREATE", "UPDATE", "DELETE"}, Resources: []string{"networkpolicies"}}},
	Variables:   []Expression{{Name: "sandbox", Expression: "namespaceObject.metadata.labels['codemowers.io/sandbox']"}},
	Validations: []Expression{{Message: "Sandbox users cannot create or update NetworkPolicies"}},
}

var ingressGuard = AdmissionPolicy{
	Name: "sandbox-ingress-guard",
	ResourceRules: []ResourceRule{
		{APIGroups: []string{"networking.k8s.io"}, Operations: []string{"CREATE", "UPDATE"}, Resources: []string{"ingresses"}},
		{APIGroups: []string{"traefik.io"}, Operations: []string{"CREATE", "UPDATE"}, Resources: []string{"ingressroutes"}},
	},
	Variables: []Expression{{Name: "sandbox", Expression: "namespaceObject.metadata.labels['codemowers.io/sandbox']"}},
	Validations: []Expression{
		{Message: "Traefik IngressRoute resources are not available in sandboxes; use a\n  standard Ingress"},
		{Message: "Ingress hosts in this sandbox must be <sandbox-id>.<domain> or"},
	},
}

var sandboxScope = map[string]string{"codemowers.io/sandbox": "abc123-demo"}

func bindingFor(policy string, edit ...func(*AdmissionBinding)) AdmissionBinding {
	b := AdmissionBinding{PolicyName: policy, NamespaceSelector: &LabelSelector{MatchLabels: map[string]string{"codemowers.io/sandbox": "abc123-demo"}}}
	for _, e := range edit {
		e(&b)
	}

	return b
}

// Observed on a real cluster: guards bound with no namespaceSelector at all.
var unscopedBinding = AdmissionBinding{PolicyName: "sandbox-egress-guard", ValidationActions: []string{"Deny"}}

func check(group, resource, op string, labels map[string]string) DenialCheck {
	return DenialCheck{Operation: Operation{Group: group, Resource: resource, Operation: op}, NamespaceLabels: labels}
}

func netpol(op string, labels map[string]string) DenialCheck {
	return check("networking.k8s.io", "networkpolicies", op, labels)
}

func denials(facts []AdmissionPolicyFact, c DenialCheck) []Denial {
	d, _ := AdmissionFor(facts, c)

	return d
}

func TestBoundPolicyIsEnforced(t *testing.T) {
	f := ToAdmissionFacts([]AdmissionPolicy{egressGuard}, []AdmissionBinding{bindingFor("sandbox-egress-guard")})[0]
	want := []GuardedOperation{{Group: "networking.k8s.io", Resource: "networkpolicies", Operations: []string{"CREATE", "UPDATE", "DELETE"}}}
	if f.Name != "sandbox-egress-guard" || !f.Enforced || !reflect.DeepEqual(f.Guards, want) ||
		!strings.Contains(f.Messages[0], "cannot create or update NetworkPolicies") {
		t.Errorf("fact = %+v", f)
	}
}

func TestEnforcement(t *testing.T) {
	// validationActions defaults to Deny when omitted.
	if f := ToAdmissionFacts([]AdmissionPolicy{egressGuard}, []AdmissionBinding{bindingFor("sandbox-egress-guard")})[0]; !f.Enforced {
		t.Error("omitted validationActions not enforced")
	}
	audit := bindingFor("sandbox-egress-guard", func(b *AdmissionBinding) { b.ValidationActions = []string{"Audit"} })
	if f := ToAdmissionFacts([]AdmissionPolicy{egressGuard}, []AdmissionBinding{audit})[0]; f.Enforced || !strings.Contains(f.Enforcement, "will not block") {
		t.Errorf("audit = %+v", f)
	}
	if f := ToAdmissionFacts([]AdmissionPolicy{egressGuard}, nil)[0]; f.Enforced || !strings.Contains(f.Enforcement, "no binding") {
		t.Errorf("unbound = %+v", f)
	}
}

func TestMessagesAndParams(t *testing.T) {
	withParams := bindingFor("sandbox-ingress-guard", func(b *AdmissionBinding) {
		b.ParamRefName, b.ParamRefNamespace = "sandbox-guard-params", "kube-system"
	})
	f := ToAdmissionFacts([]AdmissionPolicy{ingressGuard}, []AdmissionBinding{withParams})[0]
	if !slices.Contains(f.Messages, "Traefik IngressRoute resources are not available in sandboxes; use a standard Ingress") {
		t.Errorf("messages = %q", f.Messages)
	}
	if f.ParamRef == nil || f.ParamRef.Name != "sandbox-guard-params" || *f.ParamRef.Namespace != "kube-system" {
		t.Errorf("paramRef = %+v", f.ParamRef)
	}
}

func TestDenials(t *testing.T) {
	facts := ToAdmissionFacts([]AdmissionPolicy{egressGuard}, []AdmissionBinding{bindingFor("sandbox-egress-guard")})

	// Netpol creation is denied where RBAC would allow it.
	d := denials(facts, netpol("CREATE", sandboxScope))
	if len(d) != 1 || d[0].Policy != "sandbox-egress-guard" || !strings.Contains(d[0].Messages[0], "cannot create or update NetworkPolicies") {
		t.Errorf("denials = %+v", d)
	}
	if d := denials(facts, netpol("CREATE", map[string]string{})); len(d) != 0 {
		t.Errorf("non-sandbox = %+v", d)
	}
	if d := denials(facts, check("postgresql.cnpg.io", "clusters", "CREATE", sandboxScope)); len(d) != 0 {
		t.Errorf("unrelated = %+v", d)
	}
	// The binding pins one sandbox id, so another sandbox is not governed.
	if d := denials(facts, netpol("CREATE", map[string]string{"codemowers.io/sandbox": "z9y8x7-other"})); len(d) != 0 {
		t.Errorf("other sandbox = %+v", d)
	}

	ingress := ToAdmissionFacts([]AdmissionPolicy{ingressGuard}, []AdmissionBinding{bindingFor("sandbox-ingress-guard")})
	if n := len(denials(ingress, check("networking.k8s.io", "ingresses", "CREATE", sandboxScope))); n != 1 {
		t.Errorf("ingress CREATE = %d", n)
	}
	if n := len(denials(ingress, check("networking.k8s.io", "ingresses", "DELETE", sandboxScope))); n != 0 {
		t.Errorf("ingress DELETE = %d", n)
	}

	wildcard := AdmissionPolicy{Name: "catch-all", ResourceRules: []ResourceRule{{APIGroups: []string{"*"}, Resources: []string{"*"}, Operations: []string{"*"}}}}
	wf := ToAdmissionFacts([]AdmissionPolicy{wildcard}, []AdmissionBinding{bindingFor("catch-all")})
	if n := len(denials(wf, check("anything.io", "widgets", "UPDATE", sandboxScope))); n != 1 {
		t.Errorf("wildcard = %d", n)
	}
}

func TestEnforcedSortFirst(t *testing.T) {
	facts := ToAdmissionFacts([]AdmissionPolicy{ingressGuard, egressGuard}, []AdmissionBinding{bindingFor("sandbox-egress-guard")})
	if facts[0].Name != "sandbox-egress-guard" || !facts[0].Enforced || facts[1].Name != "sandbox-ingress-guard" || facts[1].Enforced {
		t.Errorf("order = %s %v, %s %v", facts[0].Name, facts[0].Enforced, facts[1].Name, facts[1].Enforced)
	}
}

func TestCELNamespaceLabelScoping(t *testing.T) {
	f := ToAdmissionFacts([]AdmissionPolicy{egressGuard}, []AdmissionBinding{unscopedBinding})
	if !slices.Equal(f[0].ScopedToNamespaceLabelKeys, []string{"codemowers.io/sandbox"}) || f[0].ScopedToNamespaceLabels != nil {
		t.Errorf("fact = %+v", f[0])
	}
	if n := len(denials(f, netpol("CREATE", sandboxScope))); n != 1 {
		t.Errorf("sandbox = %d", n)
	}
	if n := len(denials(f, netpol("CREATE", map[string]string{}))); n != 0 {
		t.Errorf("platform namespace = %d", n)
	}
	// Only presence matters, not the value.
	if n := len(denials(f, netpol("CREATE", map[string]string{"codemowers.io/sandbox": "z9y8x7-other"}))); n != 1 {
		t.Errorf("other sandbox = %d", n)
	}

	global := AdmissionPolicy{Name: "global-guard", ResourceRules: []ResourceRule{{APIGroups: []string{""}, Resources: []string{"pods"}, Operations: []string{"CREATE"}}},
		Validations: []Expression{{Message: "no"}}}
	g := ToAdmissionFacts([]AdmissionPolicy{global}, []AdmissionBinding{{PolicyName: "global-guard", ValidationActions: []string{"Deny"}}})
	if n := len(denials(g, check("", "pods", "CREATE", map[string]string{}))); n != 1 {
		t.Errorf("global = %d", n)
	}
}

// The deployed egress guard exempts by identity and carries two messages.
var deployedEgressGuard = AdmissionPolicy{
	Name: "sandbox-egress-guard",
	ResourceRules: []ResourceRule{{APIGroups: []string{"networking.k8s.io"}, Operations: []string{"CREATE", "UPDATE", "DELETE"},
		Resources: []string{"networkpolicies"}}},
	Variables: []Expression{{Name: "exempt", Expression: "request.userInfo.username.startsWith('system:serviceaccount:argocd:') || " +
		"('github.com:codemowers:admins' in request.userInfo.groups) || ('system:masters' in request.userInfo.groups)"}},
	Validations: []Expression{
		{Expression: "variables.exempt || !variables.platformManaged",
			Message: "platform-managed NetworkPolicies cannot be created, modified, or deleted by sandbox users"},
		{Expression: "variables.exempt || request.operation == 'DELETE'",
			Message: "NetworkPolicies in sandboxes are platform-managed and cannot be created or modified; custom traffic allowances are not yet self-service"},
	},
}

var deployedBinding = AdmissionBinding{PolicyName: "sandbox-egress-guard", ValidationActions: []string{"Deny"}}

func TestExemptGroups(t *testing.T) {
	facts := ToAdmissionFacts([]AdmissionPolicy{deployedEgressGuard}, []AdmissionBinding{deployedBinding})
	if !slices.Equal(facts[0].ExemptGroups, []string{"github.com:codemowers:admins", "system:masters"}) {
		t.Errorf("exempt = %v", facts[0].ExemptGroups)
	}

	c := netpol("CREATE", sandboxScope)
	c.CallerGroups = []string{}
	d := denials(facts, c)
	if len(d) != 1 || len(d[0].Messages) != 2 || !slices.ContainsFunc(d[0].Messages, func(m string) bool {
		return strings.Contains(m, "cannot be created or modified")
	}) {
		t.Errorf("denials = %+v", d)
	}
	for groups, want := range map[string]int{
		"github.com:codemowers:admins": 0,
		"system:masters":               0,
		"github.com:codemowers:users":  1,
	} {
		c.CallerGroups = []string{groups}
		if n := len(denials(facts, c)); n != want {
			t.Errorf("groups %s: denials = %d", groups, n)
		}
	}
	c = netpol("DELETE", sandboxScope)
	if n := len(denials(facts, c)); n != 1 {
		t.Errorf("DELETE = %d", n)
	}
}

var s3Guard = AdmissionPolicy{
	Name:        "sandbox-s3-guard",
	Annotations: map[string]string{EffectAnnotation: "constrains"},
	ResourceRules: []ResourceRule{{APIGroups: []string{"s3.onyxia.sh"}, APIVersions: []string{"*"}, Operations: []string{"CREATE", "UPDATE"},
		Resources: []string{"buckets", "s3users"}}},
	Variables:   []Expression{{Name: "prefix", Expression: "namespaceObject.metadata.labels['codemowers.io/sandbox'] + '-'"}},
	Validations: []Expression{{Message: "only Buckets and S3Users can be created in sandboxes"}},
}

func TestConstrainingEffect(t *testing.T) {
	facts := ToAdmissionFacts([]AdmissionPolicy{s3Guard}, []AdmissionBinding{bindingFor("sandbox-s3-guard")})
	if facts[0].Effect != "constrains" || !facts[0].Enforced {
		t.Errorf("fact = %+v", facts[0])
	}
	c := check("s3.onyxia.sh", "buckets", "CREATE", sandboxScope)
	if d := denials(facts, c); len(d) != 0 {
		t.Errorf("annotated constrains denies: %+v", d)
	}

	unannotated := s3Guard
	unannotated.Annotations = nil
	facts = ToAdmissionFacts([]AdmissionPolicy{unannotated}, []AdmissionBinding{bindingFor("sandbox-s3-guard")})
	if facts[0].Effect != "denies" || len(denials(facts, c)) != 1 {
		t.Errorf("unannotated = %+v", facts[0])
	}
}

func TestBindingLabelKeys(t *testing.T) {
	b := bindingFor("sandbox-egress-guard", func(b *AdmissionBinding) {
		b.NamespaceSelector = &LabelSelector{
			MatchLabels:      map[string]string{"codemowers.io/sandbox": "abc123-demo"},
			MatchExpressions: []LabelSelectorRequirement{{Key: "tier", Operator: "Exists"}},
		}
	})
	f := ToAdmissionFacts([]AdmissionPolicy{egressGuard}, []AdmissionBinding{b})[0]
	if !slices.Equal(f.BindingLabelKeys, []string{"codemowers.io/sandbox", "tier"}) {
		t.Errorf("keys = %v", f.BindingLabelKeys)
	}
}

func TestTenantLabelKeyFor(t *testing.T) {
	exists := AdmissionBinding{PolicyName: "sandbox-ingress-guard", NamespaceSelector: &LabelSelector{
		MatchExpressions: []LabelSelectorRequirement{{Key: "team.example.com/tenant", Operator: "Exists"}}}}
	cases := []struct {
		name     string
		policies []AdmissionPolicy
		bindings []AdmissionBinding
		want     string
	}{
		{"ingress guard selector", []AdmissionPolicy{ingressGuard}, []AdmissionBinding{exists}, "team.example.com/tenant"},
		{"CEL witness", []AdmissionPolicy{ingressGuard}, []AdmissionBinding{unscopedBinding, {PolicyName: "sandbox-ingress-guard"}}, "codemowers.io/sandbox"},
		{"other enforced guard", []AdmissionPolicy{egressGuard}, []AdmissionBinding{unscopedBinding}, "codemowers.io/sandbox"},
		{"unbound", []AdmissionPolicy{egressGuard, ingressGuard}, nil, ""},
		{"none", nil, nil, ""},
	}
	for _, tc := range cases {
		if got := TenantLabelKeyFor(ToAdmissionFacts(tc.policies, tc.bindings)); got != tc.want {
			t.Errorf("%s: TenantLabelKeyFor = %q", tc.name, got)
		}
	}
}

func TestProjection(t *testing.T) {
	b := bindingFor("sandbox-ingress-guard", func(b *AdmissionBinding) { b.ParamRefName, b.ParamRefNamespace = "p", "kube-system" })
	f := ToAdmissionFacts([]AdmissionPolicy{ingressGuard}, []AdmissionBinding{b})[0]
	raw, _ := json.Marshal(f.Projection())
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	var keys []string
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	if !slices.Equal(keys, []string{"description", "enforced", "enforcement", "guards", "messages", "name", "scopedToNamespaceLabels"}) {
		t.Errorf("projection keys = %v", keys)
	}
}

func TestDescription(t *testing.T) {
	described := ingressGuard
	described.Annotations = map[string]string{"kubernetes.io/description": "Ingresses must use\n  the sandbox domain. "}
	if d := ToAdmissionFacts([]AdmissionPolicy{described}, nil)[0].Description; d == nil || *d != "Ingresses must use the sandbox domain." {
		t.Errorf("description = %v", d)
	}
	if d := ToAdmissionFacts([]AdmissionPolicy{ingressGuard}, nil)[0].Description; d != nil {
		t.Errorf("no description = %q", *d)
	}
}

func TestBindingExpressionSelector(t *testing.T) {
	guard := AdmissionPolicy{Name: "sandbox-egress-guard",
		ResourceRules: []ResourceRule{{APIGroups: []string{"networking.k8s.io"}, Operations: []string{"CREATE"}, Resources: []string{"networkpolicies"}}},
		Validations:   []Expression{{Message: "no"}}}
	b := AdmissionBinding{PolicyName: "sandbox-egress-guard", ValidationActions: []string{"Deny"}, NamespaceSelector: &LabelSelector{
		MatchExpressions: []LabelSelectorRequirement{{Key: "codemowers.io/sandbox", Operator: "Exists"}}}}
	facts := ToAdmissionFacts([]AdmissionPolicy{guard}, []AdmissionBinding{b})
	if n := len(denials(facts, netpol("CREATE", map[string]string{"codemowers.io/tenant": "foo"}))); n != 0 {
		t.Errorf("outside selector = %d", n)
	}
	if n := len(denials(facts, netpol("CREATE", map[string]string{"codemowers.io/sandbox": "x"}))); n != 1 {
		t.Errorf("inside selector = %d", n)
	}
}

func TestSelectorMatches(t *testing.T) {
	labels := map[string]string{"tier": "web", "env": "prod"}
	req := func(key, op string, values ...string) LabelSelector {
		return LabelSelector{MatchExpressions: []LabelSelectorRequirement{{Key: key, Operator: op, Values: values}}}
	}
	cases := []struct {
		s    LabelSelector
		want bool
	}{
		{LabelSelector{}, true},
		{LabelSelector{MatchLabels: map[string]string{"tier": "web"}}, true},
		{LabelSelector{MatchLabels: map[string]string{"tier": "db"}}, false},
		{req("env", "In", "prod", "stage"), true},
		{req("env", "NotIn", "prod"), false},
		{req("team", "NotIn", "a"), true},
		{req("team", "DoesNotExist"), true},
		{req("tier", "Bogus"), false},
	}
	for i, tc := range cases {
		if got := SelectorMatches(tc.s, labels); got != tc.want {
			t.Errorf("case %d: SelectorMatches = %v", i, got)
		}
	}
}

func TestNamespaceAnnotationsAndAnchoring(t *testing.T) {
	guard := AdmissionPolicy{Name: "sandbox-ingress-guard",
		ResourceRules: []ResourceRule{{APIGroups: []string{"networking.k8s.io"}, APIVersions: []string{"v1"}, Operations: []string{"CREATE"}, Resources: []string{"ingresses"}}},
		Variables: []Expression{
			{Name: "space", Expression: "'.' + request.namespace + variables.suffix"},
			{Name: "verified", Expression: "has(namespaceObject.metadata.annotations) && 'codemowers.io/verified-domains' in namespaceObject.metadata.annotations ? " +
				"namespaceObject.metadata.annotations['codemowers.io/verified-domains'].split(',') : []"},
		},
		Validations: []Expression{{Expression: "variables.verified.size() >= 0"}}}
	legacy := AdmissionPolicy{Name: "old-guard", Variables: []Expression{{Name: "sandbox", Expression: "namespaceObject.metadata.labels['codemowers.io/sandbox']"}}}

	f := ToAdmissionFacts([]AdmissionPolicy{guard}, []AdmissionBinding{{PolicyName: "sandbox-ingress-guard"}})[0]
	old := ToAdmissionFacts([]AdmissionPolicy{legacy}, []AdmissionBinding{{PolicyName: "old-guard"}})[0]
	if !slices.Equal(f.NamespaceAnnotationKeys, []string{"codemowers.io/verified-domains"}) || !f.AnchorsOnNamespace {
		t.Errorf("guard = %v %v", f.NamespaceAnnotationKeys, f.AnchorsOnNamespace)
	}
	if len(old.NamespaceAnnotationKeys) != 0 || old.AnchorsOnNamespace {
		t.Errorf("legacy = %v %v", old.NamespaceAnnotationKeys, old.AnchorsOnNamespace)
	}
}

func TestMatchConditionNamespaces(t *testing.T) {
	block := AdmissionPolicy{Name: "default-namespace-block",
		ResourceRules: []ResourceRule{{APIGroups: []string{"*"}, APIVersions: []string{"*"}, Operations: []string{"CREATE"}, Resources: []string{"*"}}},
		MatchConditions: []Expression{
			{Name: "default-namespace", Expression: "has(request.namespace) && request.namespace == 'default'"},
			{Name: "controller-managed-resources", Expression: "!(request.resource.resource in ['endpoints', 'endpointslices', 'events'])"},
		},
		Validations: []Expression{{Expression: "false", Message: "The default namespace is reserved for platform-managed resources."}}}
	facts := ToAdmissionFacts([]AdmissionPolicy{block}, []AdmissionBinding{{PolicyName: "default-namespace-block"}})
	if !reflect.DeepEqual(facts[0].NamespaceNames, NamespaceNames{Only: []string{"default"}, Except: []string{}}) {
		t.Errorf("names = %+v", facts[0].NamespaceNames)
	}
	in := func(ns string) int {
		return len(denials(facts, check("postgresql.cnpg.io", "clusters", "CREATE",
			map[string]string{"kubernetes.io/metadata.name": ns, "codemowers.io/sandbox": "x"})))
	}
	if in("sb-78ac58-tyybid") != 0 || in("default") != 1 {
		t.Errorf("sandbox %d, default %d", in("sb-78ac58-tyybid"), in("default"))
	}

	names := func(expr string) NamespaceNames {
		p := AdmissionPolicy{Name: "p", MatchConditions: []Expression{{Expression: expr}}}

		return ToAdmissionFacts([]AdmissionPolicy{p}, []AdmissionBinding{{PolicyName: "p"}})[0].NamespaceNames
	}
	cases := map[string]NamespaceNames{
		"request.namespace in ['a', 'b']":                   {Only: []string{"a", "b"}, Except: []string{}},
		"!(request.namespace in ['kube-system', 'argocd'])": {Except: []string{"kube-system", "argocd"}},
		"request.namespace != 'kube-system'":                {Except: []string{"kube-system"}},
		"object.metadata.name == 'x'":                       {Except: []string{}},
	}
	for expr, want := range cases {
		if got := names(expr); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: names = %+v, want %+v", expr, got, want)
		}
	}
}

func validating(name string, validations []Expression, variables []Expression, annotations map[string]string) AdmissionPolicy {
	return AdmissionPolicy{Name: name, Annotations: annotations,
		ResourceRules: []ResourceRule{{APIGroups: []string{"postgresql.cnpg.io"}, APIVersions: []string{"v1"},
			Operations: []string{"CREATE", "UPDATE"}, Resources: []string{"clusters"}}},
		Variables: variables, Validations: validations}
}

var cnpgReplicas = validating("cnpg-replicas", []Expression{{
	Expression: "!has(object.spec) || !has(object.spec.instances) || (object.spec.instances >= 1 && object.spec.instances <= 2)",
	Message:    "spec.instances must be between 1 and 2.",
}}, nil, nil)

func TestEffectOf(t *testing.T) {
	e := func(exprs ...string) []Expression {
		out := make([]Expression, len(exprs))
		for i, x := range exprs {
			out[i] = Expression{Expression: x}
		}

		return out
	}
	cases := []struct {
		name string
		p    AdmissionPolicy
		want string
	}{
		{"replicas", cnpgReplicas, "constrains"},
		{"managed images", validating("cnpg-managed-images", e(
			`!(has(dyn(object).spec) && has(dyn(object).spec.imagePullPolicy)) || dyn(object).spec.imagePullPolicy == "IfNotPresent"`,
			"oldObject == null || object.spec.imageName == oldObject.spec.imageName"), nil, nil), "constrains"},
		{"via variables", validating("via-variables", e("variables.ok"), []Expression{
			{Name: "spec", Expression: "object.spec"},
			{Name: "ok", Expression: "!has(variables.spec.instances) || variables.spec.instances <= 2"},
		}, nil), "constrains"},
		{"cyclic", validating("cyclic", e("variables.a"), []Expression{
			{Name: "a", Expression: "variables.b"}, {Name: "b", Expression: "variables.a"},
		}, nil), "denies"},
		{"false", validating("legacy", e("false"), nil, nil), "denies"},
		{"namespace only", validating("default-block", e(`request.namespace != "default"`), nil, nil), "denies"},
		{"mixed", validating("mixed", e("object.spec.instances <= 2", "has(namespaceObject.metadata.labels['codemowers.io/sandbox'])"), nil, nil), "denies"},
		{"empty", validating("empty", nil, nil, nil), "denies"},
		{"lookalike", validating("lookalike", e(`request.userInfo.username != "objectstore"`), nil, nil), "denies"},
		{"forced denies", validating("forced", cnpgReplicas.Validations, nil, map[string]string{EffectAnnotation: "denies"}), "denies"},
		{"loosened", validating("loosened", e("false"), nil, map[string]string{EffectAnnotation: "constrains"}), "constrains"},
	}
	for _, tc := range cases {
		if got := effectOf(tc.p); got != tc.want {
			t.Errorf("%s: effectOf = %s, want %s", tc.name, got, tc.want)
		}
	}
}

func TestAdmissionForSplitsConstraints(t *testing.T) {
	legacy := validating("legacy", []Expression{{Expression: "false", Message: "Legacy APIs cannot be used."}}, nil, nil)
	facts := ToAdmissionFacts([]AdmissionPolicy{cnpgReplicas, legacy}, []AdmissionBinding{bindingFor("cnpg-replicas"), bindingFor("legacy")})
	d, c := AdmissionFor(facts, check("postgresql.cnpg.io", "clusters", "CREATE", sandboxScope))
	if !reflect.DeepEqual(d, []Denial{{Policy: "legacy", Messages: []string{"Legacy APIs cannot be used."}}}) ||
		!reflect.DeepEqual(c, []Denial{{Policy: "cnpg-replicas", Messages: []string{"spec.instances must be between 1 and 2."}}}) {
		t.Errorf("denials %+v, constraints %+v", d, c)
	}
}

func legacyEMQX(matchPolicy string) AdmissionPolicy {
	return AdmissionPolicy{Name: "legacy-stateful-resource-creation", MatchPolicy: matchPolicy,
		ResourceRules: []ResourceRule{{APIGroups: []string{"apps.emqx.io"}, APIVersions: []string{"v2alpha1"}, Operations: []string{"CREATE"}, Resources: []string{"emqxes"}}},
		Validations:   []Expression{{Expression: "false", Message: "Legacy stateful workload APIs cannot be used for new resources."}}}
}

func emqxCheck(version string) DenialCheck {
	c := check("apps.emqx.io", "emqxes", "CREATE", sandboxScope)
	c.Version = version

	return c
}

func TestExactMatchPolicyVersions(t *testing.T) {
	facts := ToAdmissionFacts([]AdmissionPolicy{legacyEMQX("Exact")}, []AdmissionBinding{bindingFor("legacy-stateful-resource-creation")})
	if !slices.Equal(facts[0].Guards[0].Versions, []string{"v2alpha1"}) {
		t.Errorf("versions = %v", facts[0].Guards[0].Versions)
	}
	if len(denials(facts, emqxCheck("v2beta1"))) != 0 {
		t.Error("other version denied")
	}
	if d := denials(facts, emqxCheck("v2alpha1")); len(d) != 1 || d[0].Policy != "legacy-stateful-resource-creation" {
		t.Errorf("listed version = %+v", d)
	}
	// Without a version the policy may apply, so it still denies.
	if len(denials(facts, emqxCheck(""))) != 1 {
		t.Error("unversioned check not denied")
	}

	for _, mp := range []string{"", "Equivalent"} {
		facts := ToAdmissionFacts([]AdmissionPolicy{legacyEMQX(mp)}, []AdmissionBinding{bindingFor("legacy-stateful-resource-creation")})
		if facts[0].Guards[0].Versions != nil || len(denials(facts, emqxCheck("v2beta1"))) != 1 {
			t.Errorf("matchPolicy %q narrowed by version", mp)
		}
	}
}
