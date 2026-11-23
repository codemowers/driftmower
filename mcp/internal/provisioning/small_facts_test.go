package provisioning

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

func TestParseQuantity(t *testing.T) {
	const gi = 1 << 30
	cases := []struct {
		in   string
		want float64
		ok   bool
	}{
		{"1Ki", 1024, true},
		{"2Gi", 2 * gi, true},
		{"256Mi", 256 << 20, true},
		{"10Gi", 10 * gi, true},
		{"1k", 1000, true},
		{"1G", 1e9, true},
		{"100m", 0.1, true},
		{"1", 1, true},
		{"1.5Gi", 1.5 * gi, true},
		{"0.5", 0.5, true},
		{".5", 0.5, true},
		// Unparseable is not-ok, never zero.
		{"", 0, false},
		{"  ", 0, false},
		{"lots", 0, false},
		{"10Gb", 0, false},
		{"1Gi2", 0, false},
		// Binary and decimal suffixes are not interchangeable.
		{"1K", 0, false},
		{"1ki", 0, false},
	}
	for _, tc := range cases {
		got, ok := ParseQuantity(tc.in)
		if ok != tc.ok || (ok && got != tc.want) {
			t.Errorf("ParseQuantity(%q) = %v %v, want %v %v", tc.in, got, ok, tc.want, tc.ok)
		}
	}
	g, _ := ParseQuantity("1G")
	gib, _ := ParseQuantity("1Gi")
	if g == gib {
		t.Error("1G equals 1Gi")
	}
}

func TestParseCPUAndCount(t *testing.T) {
	for in, want := range map[string]int64{"100m": 100, "1": 1000, "1.5": 1500} {
		if got, ok := ParseCPUMillis(in); !ok || got != want {
			t.Errorf("ParseCPUMillis(%q) = %d %v", in, got, ok)
		}
	}
	for in, want := range map[string]int64{"50": 50, "5": 5} {
		if got, ok := ParseCount(in); !ok || got != want {
			t.Errorf("ParseCount(%q) = %d %v", in, got, ok)
		}
	}
}

var healthy = OperatorHealth{
	Deployment: "cnpg-cloudnative-pg", Namespace: "cnpg-system", ReadyReplicas: 1, DesiredReplicas: 1,
	Version: new("1.24.1"), WatchedNamespaces: WatchedNamespaces{All: true},
}

func TestAvailabilityOf(t *testing.T) {
	a := AvailabilityOf(false, nil, new("https://cloudnative-pg.io/"))
	if a.State != StateNotInstalled || *a.InstallHref != "https://cloudnative-pg.io/" {
		t.Errorf("not installed = %+v", a)
	}
	if a := AvailabilityOf(true, nil, nil); a.State != StateCRDsOnly || !strings.Contains(a.Reason, "would succeed") {
		t.Errorf("crds-only = %+v", a)
	}
	down := healthy
	down.ReadyReplicas = 0
	if a := AvailabilityOf(true, &down, nil); a.State != StateDegraded ||
		!strings.Contains(a.Reason, "cnpg-system/cnpg-cloudnative-pg") || !strings.Contains(a.Reason, "0/1 pods ready") {
		t.Errorf("degraded = %+v", a)
	}
	if a := AvailabilityOf(true, &healthy, nil); a.State != StateReady || *a.Version != "1.24.1" {
		t.Errorf("ready = %+v", a)
	}
}

func TestAvailabilityJSON(t *testing.T) {
	cases := []struct {
		a    Availability
		want string
	}{
		{Availability{State: StateReady, Version: new("1.2"), WatchedNamespaces: WatchedNamespaces{All: true}},
			`{"state":"ready","version":"1.2","watchedNamespaces":"all"}`},
		{Availability{State: StateReady, WatchedNamespaces: WatchedNamespaces{Names: []string{"a", "b"}}},
			`{"state":"ready","version":null,"watchedNamespaces":["a","b"]}`},
		{Availability{State: StateReady}, `{"state":"ready","version":null,"watchedNamespaces":[]}`},
		{Availability{State: StateDegraded, Version: new("1"), Reason: "r"}, `{"state":"degraded","version":"1","reason":"r"}`},
		{Availability{State: StateCRDsOnly, Reason: "r"}, `{"state":"crds-only","reason":"r"}`},
		{Availability{State: StateNotInstalled}, `{"state":"not-installed","installHref":null}`},
		{Availability{State: StateNotInstalled, InstallHref: new("x")}, `{"state":"not-installed","installHref":"x"}`},
	}
	for _, tc := range cases {
		b, err := json.Marshal(tc.a)
		if err != nil || string(b) != tc.want {
			t.Errorf("Marshal(%+v) = %s %v, want %s", tc.a, b, err, tc.want)
		}
		var back Availability
		if err := json.Unmarshal(b, &back); err != nil || back.State != tc.a.State {
			t.Errorf("round trip %s = %+v %v", b, back, err)
		}
	}
	var w WatchedNamespaces
	if err := json.Unmarshal([]byte(`"all"`), &w); err != nil || !w.All {
		t.Errorf("unmarshal all = %+v %v", w, err)
	}
}

func TestOfferingsCatalog(t *testing.T) {
	want := []OfferingID{Postgres, Dragonfly, MongoDB, Bucket, RabbitMQ, Redpanda, OpenSearch, Elasticsearch, EMQX}
	if !slices.Equal(OfferingIDs, want) {
		t.Errorf("OfferingIDs = %v", OfferingIDs)
	}
	pg, ok := OfferingByID(Postgres)
	if !ok || pg.Group != "postgresql.cnpg.io" || pg.Kind != "Cluster" || pg.OperatorRef.Labels["app.kubernetes.io/name"] != "cloudnative-pg" ||
		len(pg.Presets) != 3 || pg.Presets[2].Label != "Resilience planning" {
		t.Errorf("postgres = %+v", pg)
	}
	if _, ok := OfferingByID("nope"); ok {
		t.Error("unknown offering found")
	}
}

func TestPodSecurityFor(t *testing.T) {
	const key = "pod-security.kubernetes.io/enforce"
	f := PodSecurityFor(map[string]string{key: "restricted"})
	if f == nil || f.Enforce != "restricted" || !slices.Equal(f.Requires, []string{
		"securityContext.runAsNonRoot=true",
		"securityContext.allowPrivilegeEscalation=false",
		`securityContext.capabilities.drop=["ALL"]`,
		`securityContext.seccompProfile.type="RuntimeDefault"`,
	}) || !strings.Contains(f.Summary, "cannot run as root") {
		t.Errorf("restricted = %+v", f)
	}
	if f := PodSecurityFor(map[string]string{key: "baseline"}); f == nil || len(f.Requires) != 0 ||
		!strings.Contains(f.Summary, "running as root is allowed") {
		t.Errorf("baseline = %+v", f)
	}
	if f := PodSecurityFor(map[string]string{key: "privileged"}); f == nil || !strings.Contains(f.Summary, "No pod security level") {
		t.Errorf("privileged = %+v", f)
	}
	for _, labels := range []map[string]string{nil, {}, {key: ""}, {key: "weird"}, {"pod-security.kubernetes.io/warn": "restricted"}} {
		if f := PodSecurityFor(labels); f != nil {
			t.Errorf("PodSecurityFor(%v) = %+v", labels, f)
		}
	}
}

var readyAlloc = map[string]string{"cpu": "4", "memory": "8Gi"}

func readyNode(labels map[string]string) Node {
	return Node{Labels: labels, Ready: true, Allocatable: readyAlloc}
}

func TestIsSchedulable(t *testing.T) {
	cases := []struct {
		n    Node
		want bool
	}{
		{readyNode(nil), true},
		{Node{Unschedulable: true, Ready: true}, false},
		{Node{Ready: false}, false},
		{Node{Ready: true, TaintEffects: []string{"NoSchedule"}}, false},
		{Node{Ready: true, TaintEffects: []string{"NoExecute"}}, false},
		// PreferNoSchedule is a hint, not a barrier.
		{Node{Ready: true, TaintEffects: []string{"PreferNoSchedule"}}, true},
	}
	for i, tc := range cases {
		if got := IsSchedulable(tc.n); got != tc.want {
			t.Errorf("case %d: IsSchedulable = %v", i, got)
		}
	}
}

func TestTopologyFact(t *testing.T) {
	zone := func(z string) map[string]string { return map[string]string{zoneLabel: z} }
	cordoned := readyNode(zone("eu-b"))
	cordoned.Unschedulable = true
	topo := ToTopologyFact([]Node{readyNode(zone("eu-a")), readyNode(zone("eu-a")), readyNode(zone("eu-b")), cordoned})

	if topo.SchedulableNodes != 3 || len(topo.Zones) != 2 || topo.Zones[0].Zone != "eu-a" || topo.Zones[0].Nodes != 2 ||
		topo.Zones[1].Zone != "eu-b" || topo.Zones[1].Nodes != 1 {
		t.Errorf("topology = %+v", topo)
	}
	if topo.Zones[0].Allocatable.CPUMillis != 8000 || topo.Zones[0].Allocatable.MemoryBytes != 2*8*(1<<30) {
		t.Errorf("allocatable = %+v", topo.Zones[0].Allocatable)
	}

	unzoned := ToTopologyFact([]Node{readyNode(nil), readyNode(nil)})
	if unzoned.SchedulableNodes != 2 || DistinctZones(unzoned) != 0 || unzoned.Zones[0].Zone != "(no zone label)" {
		t.Errorf("unzoned = %+v", unzoned)
	}
}

func TestDetectControlPlaneLabel(t *testing.T) {
	cases := []struct {
		labels map[string]string
		want   *Label
	}{
		{map[string]string{"node-role.kubernetes.io/control-plane": "true"}, &Label{"node-role.kubernetes.io/control-plane", "true"}},
		{map[string]string{"codemowers.cloud/node-role": "control-plane"}, &Label{"codemowers.cloud/node-role", "control-plane"}},
		{map[string]string{"foo": "bar"}, nil},
		// A node carrying both reports the more specific one.
		{map[string]string{"node-role.kubernetes.io/control-plane": "true", "codemowers.cloud/node-role": "control-plane"},
			&Label{"codemowers.cloud/node-role", "control-plane"}},
	}
	for _, tc := range cases {
		got := detectControlPlaneLabel([]Node{{Labels: tc.labels}})
		if (got == nil) != (tc.want == nil) || (got != nil && *got != *tc.want) {
			t.Errorf("detectControlPlaneLabel(%v) = %+v, want %+v", tc.labels, got, tc.want)
		}
	}
}
