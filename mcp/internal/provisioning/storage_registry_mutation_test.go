package provisioning

import (
	"reflect"
	"strings"
	"testing"
)

// The real codemowers postgres class: Retain, expansion on, no binding mode.
var codemowersPostgres = StorageClassInput{
	Name: "postgres", Provisioner: "zfs.csi.openebs.io", ReclaimPolicy: "Retain", AllowExpansion: true,
}

func TestClassifyTopology(t *testing.T) {
	for p, want := range map[string]StorageTopology{
		"zfs.csi.openebs.io":         NodeLocal,
		"topolvm.io":                 NodeLocal,
		"ebs.csi.aws.com":            Zonal,
		"rook-ceph.rbd.csi.ceph.com": ClusterWide,
		"something.unknown.io":       UnknownTopology,
	} {
		if got := ClassifyTopology(p); got != want {
			t.Errorf("ClassifyTopology(%q) = %s", p, got)
		}
	}
}

func TestReplicaSafe(t *testing.T) {
	for p, want := range map[string]bool{
		"zfs.csi.openebs.io":   false,
		"something.unknown.io": false, // unknown must not be treated as safe
		"ebs.csi.aws.com":      true,
		"cephfs.csi.ceph.com":  true,
	} {
		f, _ := ToStorageClassFact(StorageClassInput{Name: "x", Provisioner: p})
		if f.ReplicaSafe != want {
			t.Errorf("%s replicaSafe = %v", p, f.ReplicaSafe)
		}
	}
}

func TestToStorageClassFact(t *testing.T) {
	f, ok := ToStorageClassFact(codemowersPostgres)
	if !ok || f.Topology != NodeLocal || f.ReplicaSafe || f.ReclaimPolicy != "Retain" || f.BindingMode != "Immediate" || f.IsDefault {
		t.Errorf("postgres = %+v", f)
	}
	for _, want := range []string{"one machine's disks", "keeps the data after you delete", "binds before a pod is scheduled"} {
		if !strings.Contains(f.Implies, want) {
			t.Errorf("implies %q lacks %q", f.Implies, want)
		}
	}

	if f, _ := ToStorageClassFact(StorageClassInput{Name: "x", Provisioner: "ebs.csi.aws.com"}); f.ReclaimPolicy != "Delete" || f.AllowExpansion {
		t.Errorf("defaults = %+v", f)
	}
	if _, ok := ToStorageClassFact(StorageClassInput{Name: "x"}); ok {
		t.Error("class without provisioner kept")
	}
	if _, ok := ToStorageClassFact(StorageClassInput{Provisioner: "ebs.csi.aws.com"}); ok {
		t.Error("class without name kept")
	}
	if f, _ := ToStorageClassFact(StorageClassInput{Name: "gp3", Provisioner: "ebs.csi.aws.com", IsDefault: true}); !f.IsDefault {
		t.Error("default flag lost")
	}

	clause := impliesClause(NodeLocal, "Delete", true, "WaitForFirstConsumer")
	if !strings.Contains(clause, "one machine's disks") || strings.Contains(clause, "binds before a pod is scheduled") {
		t.Errorf("WaitForFirstConsumer clause = %q", clause)
	}

	mk, _ := ToStorageClassFact(StorageClassInput{Name: "standard", Provisioner: "k8s.io/minikube-hostpath", IsDefault: true})
	if mk.Topology != NodeLocal || mk.ReplicaSafe || !strings.Contains(mk.Implies, "one machine's disks") {
		t.Errorf("minikube = %+v", mk)
	}
}

func zotDeployment(name, image string, labels map[string]string) RegistryDeployment {
	return RegistryDeployment{Name: name, PodLabels: labels, Images: []string{image}}
}

func ingressTo(name, host, backend string, tls bool) RegistryIngress {
	ing := RegistryIngress{Name: name, Rules: []IngressRuleInput{{Host: host, Services: []string{backend}}}}
	if tls {
		ing.TLSHosts = []string{host}
	}

	return ing
}

func TestIsZotImage(t *testing.T) {
	for image, want := range map[string]bool{
		"ghcr.io/project-zot/zot-linux-amd64:v2.1.2":        true,
		"ghcr.io/project-zot/zot-minimal:v2.1.2@sha256:abc": true,
		"mirror.example/zot":                                true,
		"docker.io/library/registry:2":                      false,
		"ghcr.io/example/zotero:1":                          false,
	} {
		if got := IsZotImage(image); got != want {
			t.Errorf("IsZotImage(%q) = %v", image, got)
		}
	}
}

func TestFindRegistries(t *testing.T) {
	got := FindRegistries(
		[]RegistryDeployment{zotDeployment("registry", "ghcr.io/project-zot/zot-linux-amd64:v2",
			map[string]string{"app.kubernetes.io/name": "registry", "tier": "x"})},
		[]RegistryService{{Name: "other", Selector: map[string]string{"app": "web"}},
			{Name: "registry", Selector: map[string]string{"app.kubernetes.io/name": "registry"}}},
		[]RegistryIngress{ingressTo("web", "web.team.example", "other", true), ingressTo("registry", "registry.team.example", "registry", true)},
	)
	want := []RegistryFact{{Kind: "zot", Host: "registry.team.example", TLS: true, Deployment: "registry", Service: "registry", Ingress: "registry"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("FindRegistries = %+v", got)
	}

	labels := map[string]string{"app": "registry"}
	if got := FindRegistries([]RegistryDeployment{zotDeployment("distribution", "registry:2", labels)},
		[]RegistryService{{Name: "registry", Selector: labels}},
		[]RegistryIngress{ingressTo("registry", "registry.team.example", "registry", true)}); len(got) != 0 {
		t.Errorf("non-Zot = %+v", got)
	}
	if got := FindRegistries([]RegistryDeployment{zotDeployment("registry", "zot", labels)},
		[]RegistryService{{Name: "registry"}},
		[]RegistryIngress{ingressTo("r", "r.example", "registry", true)}); len(got) != 0 {
		t.Errorf("selector-less = %+v", got)
	}
	if got := FindRegistries([]RegistryDeployment{zotDeployment("registry", "zot", labels)},
		[]RegistryService{{Name: "registry", Selector: labels}}, nil); len(got) != 0 {
		t.Errorf("unpublished = %+v", got)
	}
	if got := FindRegistries([]RegistryDeployment{zotDeployment("registry", "zot", labels)},
		[]RegistryService{{Name: "registry", Selector: labels}},
		[]RegistryIngress{ingressTo("registry", "registry.lan", "registry", false)}); len(got) != 1 || got[0].TLS {
		t.Errorf("no TLS = %+v", got)
	}
}

func TestSkaffoldEnv(t *testing.T) {
	id := "alpha.example.com"
	got := SkaffoldEnvFor(KubeContextFor(&id, "quake3"), "registry.quake3.alpha.example.com", "quake3")
	want := "SKAFFOLD_KUBE_CONTEXT=alpha.example.com/quake3\nSKAFFOLD_DEFAULT_REPO=registry.quake3.alpha.example.com\n" +
		"SKAFFOLD_NAMESPACE=quake3\nSKAFFOLD_CLEANUP=false"
	if got != want {
		t.Errorf("SkaffoldEnvFor = %q", got)
	}
	if got := KubeContextFor(nil, "team-a"); got != "<cluster>/team-a" {
		t.Errorf("KubeContextFor(nil) = %q", got)
	}
}

var cnpgTLS = MutatingPolicy{
	Name:        "cnpg-tls",
	Description: "Defaults serverTLSSecret.\n  Provision the Secret before starting the Cluster.",
	ResourceRules: []ResourceRule{{APIGroups: []string{"postgresql.cnpg.io"}, Operations: []string{"CREATE", "UPDATE"},
		Resources: []string{"clusters"}}},
}

var postgresTarget = ProvisionTarget{ID: Postgres, Resources: []TargetResource{
	{Group: "postgresql.cnpg.io", Resource: "clusters"}, {Group: "", Resource: "secrets"},
}}

func TestMutationDefaults(t *testing.T) {
	facts := ToMutationFacts([]MutatingPolicy{cnpgTLS}, []MutatingBinding{{PolicyName: "cnpg-tls"}})
	want := []AdmissionDefault{{Policy: "cnpg-tls", Resource: "clusters.postgresql.cnpg.io",
		Description: new("Defaults serverTLSSecret. Provision the Secret before starting the Cluster."), NamespaceScoped: false}}
	if got := DefaultsFor(facts, postgresTarget); !reflect.DeepEqual(got, want) {
		t.Errorf("DefaultsFor = %+v", got)
	}

	updateOnly := cnpgTLS
	updateOnly.Name = "update-only"
	updateOnly.ResourceRules = []ResourceRule{{APIGroups: []string{"postgresql.cnpg.io"}, Operations: []string{"UPDATE"}, Resources: []string{"clusters"}}}
	other := cnpgTLS
	other.Name = "dragonfly-tls"
	other.ResourceRules = []ResourceRule{{APIGroups: []string{"dragonflydb.io"}, Operations: []string{"CREATE"}, Resources: []string{"dragonflies"}}}
	facts = ToMutationFacts([]MutatingPolicy{cnpgTLS, updateOnly, other},
		[]MutatingBinding{{PolicyName: "update-only"}, {PolicyName: "dragonfly-tls"}})
	if got := DefaultsFor(facts, postgresTarget); len(got) != 0 {
		t.Errorf("unbound/other/update-only = %+v", got)
	}

	facts = ToMutationFacts([]MutatingPolicy{cnpgTLS},
		[]MutatingBinding{{PolicyName: "cnpg-tls", NamespaceSelector: &LabelSelector{MatchLabels: map[string]string{"tier": "x"}}}})
	if got := DefaultsFor(facts, postgresTarget); len(got) != 1 || !got[0].NamespaceScoped {
		t.Errorf("scoped = %+v", got)
	}
}

func TestMutationExactVersion(t *testing.T) {
	legacy := MutatingPolicy{
		Name: "legacy-defaults", Description: "Defaults something on the old API only.", MatchPolicy: "Exact",
		ResourceRules: []ResourceRule{{APIGroups: []string{"apps.emqx.io"}, APIVersions: []string{"v2alpha1"},
			Operations: []string{"CREATE"}, Resources: []string{"emqxes"}}},
	}
	facts := ToMutationFacts([]MutatingPolicy{legacy}, []MutatingBinding{{PolicyName: "legacy-defaults"}})
	emqx := func(v string) ProvisionTarget {
		return ProvisionTarget{ID: EMQX, Resources: []TargetResource{{Group: "apps.emqx.io", Resource: "emqxes", Version: v}}}
	}
	if got := DefaultsFor(facts, emqx("v2beta1")); len(got) != 0 {
		t.Errorf("other version = %+v", got)
	}
	if got := DefaultsFor(facts, emqx("v2alpha1")); len(got) != 1 || got[0].Policy != "legacy-defaults" {
		t.Errorf("matching version = %+v", got)
	}
}
