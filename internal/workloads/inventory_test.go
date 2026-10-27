package workloads

import (
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

func owner(kind, name, apiVersion string, uid ...string) metav1.OwnerReference {
	controller := true
	id := kind + "/" + name
	if len(uid) > 0 {
		id = uid[0]
	}
	return metav1.OwnerReference{APIVersion: apiVersion, Kind: kind, Name: name, UID: types.UID(id), Controller: &controller}
}

func source(kind, apiVersion string) *Source {
	for _, s := range Sources {
		if s.Kind == kind {
			return s
		}
	}
	switch {
	case kind == "Certificate":
		return CertificateSource
	case kind == "Cluster" && apiVersion == CNPGSource.APIVersion:
		return CNPGSource
	}
	return &Source{APIVersion: apiVersion, Kind: kind, Resource: "clusters", MetadataOnly: true}
}

func node(kind, name string, spec map[string]any, owners []metav1.OwnerReference, labels map[string]string) *Object {
	// Clusters are CNPG's; other kinds use their source's API version.
	apiVersion := source(kind, CNPGSource.APIVersion).APIVersion
	return &Object{APIVersion: apiVersion, Kind: kind, UID: kind + "/" + name, Name: name, Namespace: "team", Owners: owners, Labels: labels, Spec: spec}
}

// spec builds a projected-shape spec from JSON.
func spec(t *testing.T, raw string) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func graph(objects ...*Object) ([]*Workload, []string) {
	var lists []List
	for _, obj := range objects {
		s := source(obj.Kind, obj.APIVersion)
		i := slices.IndexFunc(lists, func(l List) bool { return l.Source == s })
		if i < 0 {
			lists = append(lists, List{Source: s})
			i = len(lists) - 1
		}
		lists[i].Objects = append(lists[i].Objects, obj)
	}
	warnings := map[string]bool{}
	workloads := Inventory("team", lists, warnings)
	var out []string
	for warning := range warnings {
		out = append(out, warning)
	}
	slices.Sort(out)
	return workloads, out
}

func find(workloads []*Workload, kind string) *Workload {
	for _, w := range workloads {
		if w.Kind == kind {
			return w
		}
	}
	return nil
}

func eq(t *testing.T, what string, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s = %#v, want %#v", what, got, want)
	}
}

func TestOmitsEmptyNamespaceBucket(t *testing.T) {
	workloads, _ := graph()
	eq(t, "workloads", len(workloads), 0)
	workloads, _ = graph(node("Deployment", "app", nil, nil, nil))
	eq(t, "kinds", []string{workloads[0].Kind}, []string{"Deployment"})
	eq(t, "count", len(workloads), 1)
}

func TestOperatorAncestryReferencesSelectorsAndRoutes(t *testing.T) {
	workloads, warnings := graph(
		node("Cluster", "database", nil, nil, nil),
		node("StatefulSet", "db", nil, []metav1.OwnerReference{owner("Cluster", "database", "postgresql.cnpg.io/v1")}, nil),
		node("Pod", "db-0", spec(t, `{"containers":[{"image":"db:1","envFrom":[{"configMapRef":{"name":"config"}}]}],"volumes":[{"persistentVolumeClaim":{"claimName":"data"}}]}`),
			[]metav1.OwnerReference{owner("StatefulSet", "db", "apps/v1")}, map[string]string{"app": "db"}),
		node("Service", "db", spec(t, `{"selector":{"app":"db"}}`), nil, nil),
		node("Ingress", "db-route", spec(t, `{"defaultBackend":{"service":{"name":"db"}},"tls":[{"secretName":"tls"}]}`), nil, nil),
		node("ConfigMap", "config", nil, nil, nil),
		node("ConfigMap", "unused", nil, nil, nil),
		node("Secret", "tls", nil, nil, nil),
		node("Secret", "unused-secret", nil, nil, nil),
		node("PersistentVolumeClaim", "data", nil, nil, nil),
	)
	cluster := find(workloads, "Cluster")
	eq(t, "cluster", *cluster, Workload{Name: "database", Kind: "Cluster", Namespace: "team", APIVersion: "postgresql.cnpg.io/v1", UID: "Cluster/database",
		Dependencies: Dependencies{Pods: []string{"db-0"}, Images: []string{"db:1"}, ConfigMaps: []string{"config"}, Secrets: []string{"tls"},
			PVCs: []string{"data"}, Services: []string{"db"}, Ingresses: []string{"db-route"}}})
	orphaned := find(workloads, "Namespace")
	eq(t, "orphan configmaps", orphaned.ConfigMaps, []string{"unused"})
	eq(t, "orphan secrets", orphaned.Secrets, []string{"unused-secret"})
	eq(t, "warnings", len(warnings), 0)
}

func TestStandalonePodsAndScaledToZero(t *testing.T) {
	workloads, _ := graph(
		node("Pod", "standalone", spec(t, `{"containers":[{"image":"one:1"}]}`), nil, nil),
		node("Deployment", "zero", spec(t, `{"template":{"spec":{"containers":[{"image":"two:1"}]}}}`), nil, nil),
	)
	orphaned := find(workloads, "Namespace")
	eq(t, "pods", orphaned.Pods, []string{"standalone"})
	eq(t, "images", orphaned.Images, []string{"one:1"})
	eq(t, "standalone", orphaned.StandalonePods, []StandalonePod{{Name: "standalone", UID: "Pod/standalone"}})
	eq(t, "zero images", find(workloads, "Deployment").Images, []string{"two:1"})
}

func TestStaticMirrorPodsAreNotStandalone(t *testing.T) {
	mirror := node("Pod", "static", nil, nil, nil)
	mirror.Annotations = map[string]string{"kubernetes.io/config.mirror": "mirror-hash"}
	workloads, _ := graph(mirror)
	eq(t, "pods", workloads[0].Pods, []string{"static"})
	eq(t, "standalone", len(workloads[0].StandalonePods), 0)
}

func TestDanglingUIDsAndCycles(t *testing.T) {
	workloads, warnings := graph(
		node("Pod", "old", nil, []metav1.OwnerReference{owner("Deployment", "app", "apps/v1", "deleted")}, nil),
		node("Deployment", "app", nil, nil, nil),
		node("Deployment", "a", nil, []metav1.OwnerReference{owner("Deployment", "b", "apps/v1")}, nil),
		node("Deployment", "b", nil, []metav1.OwnerReference{owner("Deployment", "a", "apps/v1")}, nil),
	)
	count := func(names ...string) (n int) {
		for _, w := range workloads {
			if slices.Contains(names, w.Name) {
				n++
			}
		}
		return n
	}
	eq(t, "app roots", count("app"), 2)
	eq(t, "cycle roots", count("a", "b"), 1)
	has := func(substr string) bool {
		return slices.ContainsFunc(warnings, func(w string) bool { return strings.Contains(w, substr) })
	}
	eq(t, "cycle warning", has("cycle"), true)
	eq(t, "unverified warning", has("unverified"), true)
}

func TestAuxiliaryCustomOwnersStayInNamespaceBucket(t *testing.T) {
	workloads, _ := graph(
		node("Secret", "mat-secrets", nil, []metav1.OwnerReference{owner("StringSecret", "mat-secrets", "secretgenerator.mittwald.de/v1alpha1")}, nil),
		node("Deployment", "app", nil, nil, nil),
		node("Pod", "app-0", spec(t, `{"volumes":[{"secret":{"secretName":"consumed-secret"}}]}`), []metav1.OwnerReference{owner("Deployment", "app", "apps/v1")}, nil),
		node("Secret", "consumed-secret", nil, []metav1.OwnerReference{owner("StringSecret", "consumed-secret", "secretgenerator.mittwald.de/v1alpha1")}, nil),
	)
	eq(t, "StringSecret root", find(workloads, "StringSecret") == nil, true)
	orphaned := find(workloads, "Namespace")
	eq(t, "orphan secrets", orphaned.Secrets, []string{"mat-secrets"})
	eq(t, "orphaned owners", orphaned.Orphaned, map[string]map[string]*OrphanOwner{
		"StringSecret.secretgenerator.mittwald.de": {"mat-secrets": {APIVersion: "secretgenerator.mittwald.de/v1alpha1", UID: "StringSecret/mat-secrets",
			OwnerReferenceOnly: true, Dependencies: Dependencies{Secrets: []string{"mat-secrets"}}}},
	})
	eq(t, "deployment secrets", find(workloads, "Deployment").Secrets, []string{"consumed-secret"})
}

func TestIndirectOwnershipOfAuxiliaryResources(t *testing.T) {
	workloads, _ := graph(
		node("Deployment", "app", nil, nil, nil),
		node("Secret", "owned-secret", nil, []metav1.OwnerReference{owner("Deployment", "app", "apps/v1")}, nil),
		node("ConfigMap", "owned-config", nil, []metav1.OwnerReference{owner("Secret", "owned-secret", "v1")}, nil),
	)
	deployment := find(workloads, "Deployment")
	eq(t, "secrets", deployment.Secrets, []string{"owned-secret"})
	eq(t, "configmaps", deployment.ConfigMaps, []string{"owned-config"})
}

func TestCertificatesJoinThroughSecretsAndIngressTLS(t *testing.T) {
	workloads, _ := graph(
		node("Certificate", "direct-cert", spec(t, `{"secretName":"direct-tls"}`), nil, nil),
		node("Certificate", "ingress-cert", spec(t, `{"secretName":"ingress-tls"}`), nil, nil),
		node("Deployment", "app", nil, nil, nil),
		node("Pod", "app-0", spec(t, `{"volumes":[{"secret":{"secretName":"direct-tls"}}]}`), []metav1.OwnerReference{owner("Deployment", "app", "apps/v1")}, map[string]string{"app": "app"}),
		node("Service", "app", spec(t, `{"selector":{"app":"app"}}`), nil, nil),
		node("Ingress", "app-route", spec(t, `{"defaultBackend":{"service":{"name":"app"}},"tls":[{"secretName":"ingress-tls"}]}`), nil, nil),
		node("Secret", "direct-tls", nil, nil, nil),
		node("Secret", "ingress-tls", nil, nil, nil),
	)
	deployment := find(workloads, "Deployment")
	eq(t, "pods", deployment.Pods, []string{"app-0"})
	eq(t, "ingresses", deployment.Ingresses, []string{"app-route"})
	eq(t, "certificates", deployment.Certificates, []string{"direct-cert", "ingress-cert"})
	eq(t, "certificate root", find(workloads, "Certificate") == nil, true)
	if orphaned := find(workloads, "Namespace"); orphaned != nil {
		eq(t, "orphan certificates", len(orphaned.Certificates), 0)
	}
}

func TestNoSecondCustomOwnerLayer(t *testing.T) {
	workloads, _ := graph(
		node("Cluster", "database", nil, []metav1.OwnerReference{owner("Application", "parent", "custom.example/v1")}, nil),
		node("Pod", "db-0", nil, []metav1.OwnerReference{owner("Cluster", "database", "postgresql.cnpg.io/v1")}, nil),
	)
	eq(t, "pods", find(workloads, "Cluster").Pods, []string{"db-0"})
	eq(t, "application root", find(workloads, "Application") == nil, true)
}

func TestProjectionKeepsReferencesOnly(t *testing.T) {
	projected, _ := json.Marshal(ProjectSpec("Pod", spec(t, `{"containers":[{"image":"app:1","command":["sensitive-command"],
		"env":[{"name":"PASSWORD","value":"sensitive-value"},{"valueFrom":{"secretKeyRef":{"name":"credentials"}}}]}]}`)))
	text := string(projected)
	eq(t, "sensitive", strings.Contains(text, "sensitive"), false)
	eq(t, "credentials", strings.Contains(text, "credentials"), true)
	eq(t, "image", strings.Contains(text, "app:1"), true)
}

func reflected(kind, name string) *Object {
	obj := node(kind, name, nil, nil, nil)
	obj.Annotations = map[string]string{"reflector.v1.k8s.emberstack.com/reflects": "registry/" + name}
	return obj
}

func shared() []*Object {
	return []*Object{
		reflected("Secret", "zot-registry-cluster-pull"),
		reflected("ConfigMap", "shared-config"),
		node("Secret", "trusted-ca-certs", nil, nil, map[string]string{"trust.cert-manager.io/bundle": "trusted-ca-certs"}),
		node("ConfigMap", "trusted-ca-certs", nil, nil, map[string]string{"trust.cert-manager.io/bundle": "trusted-ca-certs"}),
		node("ConfigMap", "kube-root-ca.crt", nil, nil, nil),
		node("Secret", "sh.helm.release.v1.checkers.v73", nil, nil, map[string]string{"owner": "helm"}),
	}
}

func TestSharedGeneratedResourcesAreNotOrphans(t *testing.T) {
	workloads, _ := graph(shared()...)
	eq(t, "workloads", len(workloads), 0)
}

func TestConsumedGeneratedResourcesAreDependencies(t *testing.T) {
	workloads, _ := graph(append([]*Object{node("Deployment", "app", spec(t, `{"template":{"spec":{
		"imagePullSecrets":[{"name":"zot-registry-cluster-pull"}],
		"volumes":[{"name":"trust","configMap":{"name":"trusted-ca-certs"}},{"name":"config","configMap":{"name":"shared-config"}},
			{"name":"api-ca","configMap":{"name":"kube-root-ca.crt"}},{"name":"secret","secret":{"secretName":"trusted-ca-certs"}}]}}}`), nil, nil)},
		shared()...)...)
	eq(t, "workloads", len(workloads), 1)
	eq(t, "secrets", workloads[0].Secrets, []string{"trusted-ca-certs", "zot-registry-cluster-pull"})
	eq(t, "configmaps", workloads[0].ConfigMaps, []string{"kube-root-ca.crt", "shared-config", "trusted-ca-certs"})
}

func TestUnmarkedAndManagedResourcesStayOrphans(t *testing.T) {
	workloads, _ := graph(
		node("Secret", "zot-registry-cluster-pull", nil, nil, nil),
		node("Secret", "sh.helm.release.v1.fake.v1", nil, nil, nil),
		node("Secret", "app", nil, nil, map[string]string{"owner": "helm"}),
		node("Secret", "tls", nil, nil, map[string]string{"controller.cert-manager.io/fao": "true"}),
		node("ConfigMap", "app", nil, nil, map[string]string{"app.kubernetes.io/managed-by": "Helm"}),
	)
	eq(t, "secrets", workloads[0].Secrets, []string{"app", "sh.helm.release.v1.fake.v1", "tls", "zot-registry-cluster-pull"})
	eq(t, "configmaps", workloads[0].ConfigMaps, []string{"app"})
}

func TestCNPGReferencesAndCertificate(t *testing.T) {
	workloads, _ := graph(
		node("Cluster", "database", spec(t, `{"certificates":{"serverTLSSecret":"database-tls","serverCASecret":"database-tls","clientCASecret":"client-ca","replicationTLSSecret":"replication-tls"},
			"monitoring":{"customQueriesConfigMap":[{"name":"cnpg-default-monitoring","key":"queries"}],"customQueriesSecret":[{"name":"private-queries","key":"queries"}]}}`), nil, nil),
		node("Pod", "database-1", nil, []metav1.OwnerReference{owner("Cluster", "database", CNPGSource.APIVersion)}, nil),
		node("Certificate", "database", spec(t, `{"secretName":"database-tls"}`), nil, nil),
		node("Secret", "database-tls", nil, nil, nil),
		node("ConfigMap", "cnpg-default-monitoring", nil, nil, nil),
	)
	eq(t, "workloads", len(workloads), 1)
	cluster := workloads[0]
	eq(t, "kind", cluster.Kind+"/"+cluster.Name, "Cluster/database")
	eq(t, "pods", cluster.Pods, []string{"database-1"})
	eq(t, "secrets", cluster.Secrets, []string{"client-ca", "database-tls", "private-queries", "replication-tls"})
	eq(t, "configmaps", cluster.ConfigMaps, []string{"cnpg-default-monitoring"})
	eq(t, "certificates", cluster.Certificates, []string{"database"})
	eq(t, "ownerReferenceOnly", cluster.OwnerReferenceOnly, false)
}

func TestCNPGProjectionKeepsExplicitReferencesOnly(t *testing.T) {
	eq(t, "projection", ProjectSpec("Cluster", spec(t, `{"certificates":{"serverTLSSecret":"tls","extra":"sensitive"},
		"monitoring":{"customQueriesConfigMap":[{"name":"queries","key":"sql","extra":"sensitive"}]},
		"bootstrap":{"initdb":{"password":"sensitive"}},"postgresql":{"parameters":{"custom":"sensitive"}}}`)),
		map[string]any{
			"certificates": map[string]any{"serverTLSSecret": "tls"},
			"monitoring":   map[string]any{"customQueriesConfigMap": []any{map[string]any{"name": "queries"}}, "customQueriesSecret": []any{}},
		})
}
