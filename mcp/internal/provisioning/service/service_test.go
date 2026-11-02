package service_test

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	k8stesting "k8s.io/client-go/testing"

	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/catalog"
	"github.com/codemowers/driftmower/mcp/internal/provisioning"
	"github.com/codemowers/driftmower/mcp/internal/provisioning/facts"
	"github.com/codemowers/driftmower/mcp/internal/provisioning/service"
	"github.com/codemowers/driftmower/mcp/internal/testutil/kubetest"
)

type judgeFunc func(authz.Identity, authz.Attributes) authz.Verdict

func (f judgeFunc) MayPerform(_ context.Context, id authz.Identity, a authz.Attributes) authz.Judgement {
	v := f(id, a)
	if v == authz.Yes {
		return authz.Judgement{Verdict: v}
	}

	return authz.Judgement{Verdict: v, Reason: "Kubernetes RBAC denies " + a.String()}
}

// alice may do anything in team-a except create RoleBindings, and nothing in
// team-b.
var alice = authz.Identity{User: "issuer#alice", Groups: []string{"system:authenticated"}}

var judge = judgeFunc(func(id authz.Identity, a authz.Attributes) authz.Verdict {
	switch {
	case a.Namespace == "team-a" && a.Resource == "rolebindings":
		return authz.No
	case a.Namespace == "team-a":
		return authz.Yes
	case a.Namespace == "" && a.Resource == "clusterissuers":
		return authz.Yes
	default:
		return authz.No
	}
})

func newService(c *kubetest.Cluster) *service.Service {
	id := "bravo.example.com"
	f := facts.New(facts.Options{
		Kubernetes: c.Kubernetes, Dynamic: c.Dynamic, Catalog: catalog.New(c.Kubernetes, c.Dynamic), Judge: judge,
		ClusterFactTTL: time.Minute, TopologyTTL: time.Minute, OperatorTTL: time.Minute,
		ClusterID: func() *string { return &id },
	})

	return service.New(f, judge, 20)
}

func TestDescribePlatform(t *testing.T) {
	p, u := newService(kubetest.ProvisioningCluster()).DescribePlatform(context.Background())
	if u != nil {
		t.Fatal(u.Detail)
	}

	if p.OfferingsTotal != 9 || p.OfferingsReady != 1 {
		t.Errorf("offerings = %d/%d", p.OfferingsReady, p.OfferingsTotal)
	}
	if got := []string{p.StorageClasses[0].Name, p.StorageClasses[1].Name}; !slices.Equal(got, []string{"cephfs", "local"}) ||
		p.StorageClasses[1].Topology != provisioning.NodeLocal {
		t.Errorf("storage = %+v", p.StorageClasses)
	}
	if p.Topology.SchedulableNodes != 1 || p.Topology.ControlPlaneLabel == nil {
		t.Errorf("topology = %+v", p.Topology)
	}
	if p.Ingress.DomainSuffix == nil || *p.Ingress.DomainSuffix != "apps.example.com" || *p.Ingress.DomainSuffixSource != "guard-params" {
		t.Errorf("ingress = %+v", p.Ingress)
	}
	if !strings.Contains(p.Ingress.TLSAdvice, "letsencrypt ClusterIssuer over ACME HTTP-01") {
		t.Errorf("tls advice = %q", p.Ingress.TLSAdvice)
	}
	if p.TenantLabelKey == nil || *p.TenantLabelKey != "codemowers.io/tenant" {
		t.Errorf("tenant label = %v", p.TenantLabelKey)
	}
	if p.NetworkPolicyEngine != "native" || len(p.Policies) != 0 || len(p.Degraded) != 0 {
		t.Errorf("engine %q, kyverno %v, degraded %v", p.NetworkPolicyEngine, p.Policies, p.Degraded)
	}
	if got := []string{p.PriorityClasses[0].Name, p.PriorityClasses[1].Name}; !slices.Equal(got, []string{"low", "high"}) {
		t.Errorf("priority classes = %v", got)
	}

	md := service.FormatPlatform(p)
	for _, want := range []string{"1 of 9 offerings ready", "**cephfs** (default)", "`apps.example.com`", "**tenant-ingress-hosts** — enforced"} {
		if !strings.Contains(md, want) {
			t.Errorf("markdown lacks %q:\n%s", want, md)
		}
	}
}

func TestCapabilitiesWithholdAndHostRules(t *testing.T) {
	svc := newService(kubetest.ProvisioningCluster())
	resp, err := svc.Capabilities(context.Background(), &alice, []string{"team-a", " team-b", "team-a"}, provisioning.Postgres)
	if err != nil {
		t.Fatal(err)
	}

	if resp.Offerings[0].ID != provisioning.Postgres || resp.Offerings[0].Availability.State != provisioning.StateReady ||
		*resp.Offerings[0].Availability.Version != "1.24" {
		t.Errorf("first offering = %+v", resp.Offerings[0])
	}
	if !slices.Equal(resp.Withheld, []string{"team-b"}) || len(resp.Namespaces) != 1 {
		t.Fatalf("withheld %v, namespaces %d", resp.Withheld, len(resp.Namespaces))
	}

	ns := resp.Namespaces[0]
	if ns.Tenant == nil || ns.Tenant.ID != "acme" || *ns.Sandbox != "acme" {
		t.Errorf("tenant = %+v", ns.Tenant)
	}
	if ns.MayCreate != authz.Yes || ns.Offerings[provisioning.Postgres].Verdict != authz.Yes {
		t.Errorf("may create = %s %q", ns.MayCreate, ns.MayCreateReason)
	}
	// RoleBindings are not in this cluster's discovery, so the admin tier is
	// unknown rather than denied.
	if ns.Access == nil || ns.Access.Admin != authz.Unknown || ns.Access.View != authz.Yes {
		t.Errorf("access = %+v", ns.Access)
	}
	if ns.Headroom == nil || *ns.Headroom.CPUMillis != 1500 || *ns.Headroom.MemoryBytes != 3*(1<<30) {
		t.Errorf("headroom = %+v", ns.Headroom)
	}
	if ns.Network.Ingress != provisioning.DefaultDeny || ns.Network.Egress != provisioning.Open || ns.Network.CiliumAvailable {
		t.Errorf("network = %+v", ns.Network)
	}
	if ns.PodSecurity == nil || ns.PodSecurity.Enforce != "restricted" {
		t.Errorf("pod security = %+v", ns.PodSecurity)
	}

	rule := resp.Ingress.HostRules[0]
	if rule.ExactHost == nil || *rule.ExactHost != "acme.apps.example.com" || *rule.LabelledPattern != "acme-<label>.apps.example.com" ||
		*rule.EnforcedBy != "tenant-ingress-hosts" {
		t.Errorf("host rule = %+v", rule)
	}

	// The wire shape the UI relays.
	raw, _ := json.Marshal(resp)
	var wire map[string]any
	_ = json.Unmarshal(raw, &wire)
	first := wire["offerings"].([]any)[0].(map[string]any)["availability"].(map[string]any)
	if first["state"] != "ready" || first["watchedNamespaces"] != "all" {
		t.Errorf("availability wire = %v", first)
	}
	if _, ok := wire["withheld"]; !ok {
		t.Error("withheld missing from the wire")
	}

	if _, err := svc.Capabilities(context.Background(), &alice, make([]string, 0), ""); err != nil {
		t.Errorf("no namespaces: %v", err)
	}
	many := make([]string, 21)
	for i := range many {
		many[i] = "ns-" + string(rune('a'+i))
	}
	var tooMany service.ErrTooManyNamespaces
	if _, err := svc.Capabilities(context.Background(), &alice, many, ""); !errors.As(err, &tooMany) {
		t.Errorf("err = %v", err)
	}
}

func TestReadinessFormat(t *testing.T) {
	r, u := newService(kubetest.ProvisioningCluster()).DescribeNamespaceReadiness(context.Background(), &alice, []string{"team-a", "team-b"}, provisioning.Postgres)
	if u != nil {
		t.Fatal(u.Detail)
	}
	md := service.FormatReadiness(r, true)
	for _, want := range []string{
		"## Namespace readiness — 1 of 2 namespace(s) reported",
		"No facts were returned for `team-b`",
		"### team-a (`codemowers.io/tenant=acme`)",
		"ResourceQuota `compute`: 1500m CPU, 3.0Gi memory",
		"Pod Security Admission enforces **restricted**",
		"Hostnames this namespace may claim: `acme.apps.example.com` or `acme-<label>.apps.example.com`",
		"Access (from the cluster authorizer):",
	} {
		if !strings.Contains(md, want) {
			t.Errorf("markdown lacks %q:\n%s", want, md)
		}
	}
}

func TestCheckAccess(t *testing.T) {
	svc := newService(kubetest.ProvisioningCluster())
	ctx := context.Background()

	// The guard governs ingress creation in a tenant namespace even though
	// RBAC allows it.
	r, u := svc.CheckAccess(ctx, &alice, service.AccessCheckInput{Verb: "create", Group: "networking.k8s.io", Resource: "ingresses", Namespace: "team-a"})
	if u != nil {
		t.Fatal(u.Detail)
	}
	if r.RBAC.Verdict != authz.Yes || len(r.Admission) != 0 || len(r.AdmissionConstraints) != 1 || r.Verdict != authz.Yes {
		t.Errorf("create ingresses = %+v", r)
	}
	if !strings.Contains(r.Reason, "Enforced admission policies (tenant-ingress-hosts) validate the manifest") {
		t.Errorf("reason = %q", r.Reason)
	}

	r, _ = svc.CheckAccess(ctx, &alice, service.AccessCheckInput{Verb: "create", Group: "rbac.authorization.k8s.io", Resource: "rolebindings", Namespace: "team-a"})
	if r.Verdict != authz.No {
		t.Errorf("create rolebindings = %+v", r)
	}

	r, _ = svc.CheckAccess(ctx, nil, service.AccessCheckInput{Verb: "get", Resource: "pods", Subresource: "log", Namespace: "team-a"})
	if r.Verdict != authz.Unknown || !strings.Contains(r.Reason, "kubectl auth can-i get pods/log.core") {
		t.Errorf("anonymous = %+v", r)
	}
	md := service.FormatAccessCheck(r, service.AccessCheckInput{Verb: "get", Resource: "pods", Namespace: "team-a"})
	if !strings.HasPrefix(md, "## get pods.core in namespace team-a — unknown") {
		t.Errorf("markdown = %s", md)
	}
}

func TestDegradedReads(t *testing.T) {
	c := kubetest.ProvisioningCluster()
	c.Dynamic.PrependReactor("list", "storageclasses", func(a k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Group: "storage.k8s.io", Resource: "storageclasses"}, "", errors.New("no"))
	})
	p, u := newService(c).DescribePlatform(context.Background())
	if u != nil {
		t.Fatal(u.Detail)
	}
	if len(p.StorageClasses) != 0 || len(p.Degraded) != 1 || p.Degraded[0].Source != "storageclasses" || p.Degraded[0].Status != 403 {
		t.Errorf("storage %v, degraded %+v", p.StorageClasses, p.Degraded)
	}
	if md := service.FormatPlatform(p); !strings.Contains(md, "### Facts that could not be read") {
		t.Errorf("markdown hides the refused read:\n%s", md)
	}
}

func TestUnreachableCluster(t *testing.T) {
	c := kubetest.ProvisioningCluster()
	c.Kubernetes.PrependReactor("list", "deployments", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("connection refused")
	})
	_, u := newService(c).DescribePlatform(context.Background())
	if u == nil || u.Reason != "kubernetes_unreachable" || !strings.Contains(u.Detail, "connection refused") {
		t.Errorf("unavailable = %+v", u)
	}
}
