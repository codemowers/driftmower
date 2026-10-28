package workloads

import (
	"encoding/json"
	"maps"
	"slices"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
)

const ns = "team"

func ownerRef(kind, name, apiVersion string) metav1.OwnerReference {
	return ownerRefUID(kind, name, apiVersion, kind+"/"+name)
}

func ownerRefUID(kind, name, apiVersion, uid string) metav1.OwnerReference {
	t := true

	return metav1.OwnerReference{Kind: kind, Name: name, APIVersion: apiVersion, UID: types.UID(uid), Controller: &t}
}

type opts struct {
	owners      []metav1.OwnerReference
	labels      map[string]string
	annotations map[string]string
}

func objMeta(kind, name string, o opts) metav1.ObjectMeta {
	return metav1.ObjectMeta{Name: name, Namespace: ns, UID: types.UID(kind + "/" + name),
		OwnerReferences: o.owners, Labels: o.labels, Annotations: o.annotations}
}

func sourceFor(t *testing.T, kind string) Source {
	t.Helper()
	for _, s := range Sources {
		if s.Kind == kind {
			return s
		}
	}
	switch kind {
	case CertificateSource.Kind:
		return CertificateSource
	case CNPGSource.Kind:
		return CNPGSource
	}
	t.Fatalf("no source for %s", kind)

	return Source{}
}

func project(t *testing.T, kind string, obj any) *Node {
	t.Helper()
	n, err := Project(sourceFor(t, kind), obj)
	if err != nil {
		t.Fatal(err)
	}

	return n
}

func pod(t *testing.T, name string, spec corev1.PodSpec, o opts) *Node {
	return project(t, "Pod", &corev1.Pod{ObjectMeta: objMeta("Pod", name, o), Spec: spec})
}

func deployment(t *testing.T, name string, spec corev1.PodSpec, o opts) *Node {
	return project(t, "Deployment", &appsv1.Deployment{ObjectMeta: objMeta("Deployment", name, o),
		Spec: appsv1.DeploymentSpec{Template: corev1.PodTemplateSpec{Spec: spec}}})
}

func statefulSet(t *testing.T, name string, o opts) *Node {
	return project(t, "StatefulSet", &appsv1.StatefulSet{ObjectMeta: objMeta("StatefulSet", name, o)})
}

func meta(t *testing.T, kind, name string, o opts) *Node {
	return project(t, kind, &metav1.PartialObjectMetadata{ObjectMeta: objMeta(kind, name, o)})
}

func service(t *testing.T, name string, selector map[string]string) *Node {
	return project(t, "Service", &corev1.Service{ObjectMeta: objMeta("Service", name, opts{}), Spec: corev1.ServiceSpec{Selector: selector}})
}

func ingressTo(t *testing.T, name, svc, tlsSecret string) *Node {
	return project(t, "Ingress", &networkingv1.Ingress{ObjectMeta: objMeta("Ingress", name, opts{}), Spec: networkingv1.IngressSpec{
		DefaultBackend: &networkingv1.IngressBackend{Service: &networkingv1.IngressServiceBackend{Name: svc}},
		TLS:            []networkingv1.IngressTLS{{SecretName: tlsSecret}},
	}})
}

func unstructuredNode(t *testing.T, kind, apiVersion, name string, spec map[string]any, o opts) *Node {
	u := &unstructured.Unstructured{Object: map[string]any{"apiVersion": apiVersion, "kind": kind, "spec": spec}}
	m := objMeta(kind, name, o)
	u.SetName(m.Name)
	u.SetNamespace(m.Namespace)
	u.SetUID(m.UID)
	u.SetOwnerReferences(m.OwnerReferences)
	u.SetLabels(m.Labels)

	return project(t, kind, u)
}

func cluster(t *testing.T, name string, spec map[string]any, o opts) *Node {
	return unstructuredNode(t, "Cluster", CNPGSource.APIVersion(), name, spec, o)
}

func certificate(t *testing.T, name, secret string) *Node {
	return unstructuredNode(t, "Certificate", CertificateSource.APIVersion(), name, map[string]any{"secretName": secret}, opts{})
}

// graph groups nodes by source in the order of the TS sources list, then the
// optional adapters.
func graph(t *testing.T, nodes ...*Node) ([]*Workload, []string) {
	t.Helper()
	order := append(slices.Clone(Sources), CertificateSource, CNPGSource)
	var lists []SourceItems
	for _, s := range order {
		var items []*Node
		for _, n := range nodes {
			if n.Kind == s.Kind && n.APIVersion == s.APIVersion() {
				items = append(items, n)
			}
		}
		if len(items) > 0 {
			lists = append(lists, SourceItems{Source: s, Items: items})
		}
	}
	warnings := map[string]bool{}
	w := BuildInventory(ns, lists, warnings)

	return w, slices.Sorted(maps.Keys(warnings))
}

func find(ws []*Workload, kind string) *Workload {
	for _, w := range ws {
		if w.Kind == kind {
			return w
		}
	}

	return nil
}

func eq(t *testing.T, what string, got, want []string) {
	t.Helper()
	if !slices.Equal(got, want) {
		t.Errorf("%s = %v, want %v", what, got, want)
	}
}

func TestOmitsEmptyNamespaceBucket(t *testing.T) {
	if w, _ := graph(t); len(w) != 0 {
		t.Errorf("empty graph = %v", w)
	}
	w, _ := graph(t, deployment(t, "app", corev1.PodSpec{}, opts{}))
	if len(w) != 1 || w[0].Kind != "Deployment" {
		t.Errorf("workloads = %+v", w)
	}
}

func TestOperatorAncestryReferencesSelectorsRoutes(t *testing.T) {
	w, warnings := graph(t,
		cluster(t, "database", map[string]any{}, opts{}),
		statefulSet(t, "db", opts{owners: []metav1.OwnerReference{ownerRef("Cluster", "database", "postgresql.cnpg.io/v1")}}),
		pod(t, "db-0", corev1.PodSpec{
			Containers: []corev1.Container{{Image: "db:1", EnvFrom: []corev1.EnvFromSource{{ConfigMapRef: &corev1.ConfigMapEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: "config"}}}}}},
			Volumes:    []corev1.Volume{{Name: "data", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: "data"}}}},
		}, opts{owners: []metav1.OwnerReference{ownerRef("StatefulSet", "db", "apps/v1")}, labels: map[string]string{"app": "db"}}),
		service(t, "db", map[string]string{"app": "db"}),
		ingressTo(t, "db-route", "db", "tls"),
		meta(t, "ConfigMap", "config", opts{}),
		meta(t, "ConfigMap", "unused", opts{}),
		meta(t, "Secret", "tls", opts{}),
		meta(t, "Secret", "unused-secret", opts{}),
		meta(t, "PersistentVolumeClaim", "data", opts{}),
	)

	c := find(w, "Cluster")
	if c == nil || c.Name != "database" || c.APIVersion != "postgresql.cnpg.io/v1" || c.UID != "Cluster/database" {
		t.Fatalf("cluster = %+v", c)
	}
	eq(t, "pods", c.Pods, []string{"db-0"})
	eq(t, "images", c.Images, []string{"db:1"})
	eq(t, "configmaps", c.ConfigMaps, []string{"config"})
	eq(t, "secrets", c.Secrets, []string{"tls"})
	eq(t, "pvcs", c.PVCs, []string{"data"})
	eq(t, "services", c.Services, []string{"db"})
	eq(t, "ingresses", c.Ingresses, []string{"db-route"})

	o := find(w, "Namespace")
	eq(t, "orphan configmaps", o.ConfigMaps, []string{"unused"})
	eq(t, "orphan secrets", o.Secrets, []string{"unused-secret"})
	if len(warnings) != 0 {
		t.Errorf("warnings = %v", warnings)
	}
}

func TestStandalonePodsAndScaledToZero(t *testing.T) {
	w, _ := graph(t,
		pod(t, "standalone", corev1.PodSpec{Containers: []corev1.Container{{Image: "one:1"}}}, opts{}),
		deployment(t, "zero", corev1.PodSpec{Containers: []corev1.Container{{Image: "two:1"}}}, opts{}),
	)
	o := find(w, "Namespace")
	eq(t, "orphan pods", o.Pods, []string{"standalone"})
	eq(t, "orphan images", o.Images, []string{"one:1"})
	if !slices.Equal(o.StandalonePods, []StandalonePod{{Name: "standalone", UID: "Pod/standalone"}}) {
		t.Errorf("standalone = %v", o.StandalonePods)
	}
	d := find(w, "Deployment")
	if d.Name != "zero" {
		t.Errorf("deployment = %+v", d)
	}
	eq(t, "deployment images", d.Images, []string{"two:1"})
}

func TestMirrorPodsAreNotStandalone(t *testing.T) {
	w, _ := graph(t, pod(t, "static", corev1.PodSpec{}, opts{annotations: map[string]string{"kubernetes.io/config.mirror": "mirror-hash"}}))
	eq(t, "pods", w[0].Pods, []string{"static"})
	if w[0].StandalonePods != nil {
		t.Errorf("standalone = %v", w[0].StandalonePods)
	}
}

func TestDanglingUIDsAndCycles(t *testing.T) {
	w, warnings := graph(t,
		pod(t, "old", corev1.PodSpec{}, opts{owners: []metav1.OwnerReference{ownerRefUID("Deployment", "app", "apps/v1", "deleted")}}),
		deployment(t, "app", corev1.PodSpec{}, opts{}),
		deployment(t, "a", corev1.PodSpec{}, opts{owners: []metav1.OwnerReference{ownerRef("Deployment", "b", "apps/v1")}}),
		deployment(t, "b", corev1.PodSpec{}, opts{owners: []metav1.OwnerReference{ownerRef("Deployment", "a", "apps/v1")}}),
	)
	apps, ab := 0, 0
	for _, x := range w {
		switch x.Name {
		case "app":
			apps++
		case "a", "b":
			ab++
		}
	}
	if apps != 2 || ab != 1 {
		t.Errorf("app=%d a/b=%d: %+v", apps, ab, w)
	}
	joined := strings.Join(warnings, "\n")
	if !strings.Contains(joined, "cycle") || !strings.Contains(joined, "unverified") {
		t.Errorf("warnings = %v", warnings)
	}
}

func TestAuxiliaryCustomOwnersStayInNamespaceBucket(t *testing.T) {
	gen := "secretgenerator.mittwald.de/v1alpha1"
	w, _ := graph(t,
		meta(t, "Secret", "mat-secrets", opts{owners: []metav1.OwnerReference{ownerRef("StringSecret", "mat-secrets", gen)}}),
		deployment(t, "app", corev1.PodSpec{}, opts{}),
		pod(t, "app-0", corev1.PodSpec{Volumes: []corev1.Volume{{Name: "s", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: "consumed-secret"}}}}},
			opts{owners: []metav1.OwnerReference{ownerRef("Deployment", "app", "apps/v1")}}),
		meta(t, "Secret", "consumed-secret", opts{owners: []metav1.OwnerReference{ownerRef("StringSecret", "consumed-secret", gen)}}),
	)
	if find(w, "StringSecret") != nil {
		t.Error("custom owner became a root")
	}
	o := find(w, "Namespace")
	eq(t, "orphan secrets", o.Secrets, []string{"mat-secrets"})
	entry := o.Orphaned["StringSecret.secretgenerator.mittwald.de"]["mat-secrets"]
	if entry == nil || entry.APIVersion != gen || entry.UID != "StringSecret/mat-secrets" || !entry.OwnerReferenceOnly {
		t.Fatalf("orphaned = %+v", o.Orphaned)
	}
	eq(t, "entry secrets", entry.Secrets, []string{"mat-secrets"})
	if len(o.Orphaned["StringSecret.secretgenerator.mittwald.de"]) != 1 {
		t.Errorf("consumed secret grouped as orphan: %+v", o.Orphaned)
	}
	eq(t, "deployment secrets", find(w, "Deployment").Secrets, []string{"consumed-secret"})
}

func TestIndirectOwnershipOfAuxiliaryResources(t *testing.T) {
	w, _ := graph(t,
		deployment(t, "app", corev1.PodSpec{}, opts{}),
		meta(t, "Secret", "owned-secret", opts{owners: []metav1.OwnerReference{ownerRef("Deployment", "app", "apps/v1")}}),
		meta(t, "ConfigMap", "owned-config", opts{owners: []metav1.OwnerReference{ownerRef("Secret", "owned-secret", "v1")}}),
	)
	d := find(w, "Deployment")
	eq(t, "secrets", d.Secrets, []string{"owned-secret"})
	eq(t, "configmaps", d.ConfigMaps, []string{"owned-config"})
}

func TestCertificatesJoinDirectAndIngressTLS(t *testing.T) {
	w, _ := graph(t,
		certificate(t, "direct-cert", "direct-tls"),
		certificate(t, "ingress-cert", "ingress-tls"),
		deployment(t, "app", corev1.PodSpec{}, opts{}),
		pod(t, "app-0", corev1.PodSpec{Volumes: []corev1.Volume{{Name: "s", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: "direct-tls"}}}}},
			opts{owners: []metav1.OwnerReference{ownerRef("Deployment", "app", "apps/v1")}, labels: map[string]string{"app": "app"}}),
		service(t, "app", map[string]string{"app": "app"}),
		ingressTo(t, "app-route", "app", "ingress-tls"),
		meta(t, "Secret", "direct-tls", opts{}),
		meta(t, "Secret", "ingress-tls", opts{}),
	)
	d := find(w, "Deployment")
	eq(t, "pods", d.Pods, []string{"app-0"})
	eq(t, "ingresses", d.Ingresses, []string{"app-route"})
	eq(t, "certificates", d.Certificates, []string{"direct-cert", "ingress-cert"})
	if find(w, "Certificate") != nil {
		t.Error("certificate became a root")
	}
	if o := find(w, "Namespace"); o != nil && o.Certificates != nil {
		t.Errorf("orphan certificates = %v", o.Certificates)
	}
}

func TestNoSecondCustomOwnerLayer(t *testing.T) {
	w, _ := graph(t,
		cluster(t, "database", map[string]any{}, opts{owners: []metav1.OwnerReference{ownerRef("Application", "parent", "custom.example/v1")}}),
		pod(t, "db-0", corev1.PodSpec{}, opts{owners: []metav1.OwnerReference{ownerRef("Cluster", "database", "postgresql.cnpg.io/v1")}}),
	)
	eq(t, "cluster pods", find(w, "Cluster").Pods, []string{"db-0"})
	if find(w, "Application") != nil {
		t.Error("second custom layer traversed")
	}
}

func TestProjectKeepsReferencesOnly(t *testing.T) {
	n := pod(t, "p", corev1.PodSpec{Containers: []corev1.Container{{
		Image:   "app:1",
		Command: []string{"sensitive-command"},
		Env: []corev1.EnvVar{
			{Name: "PASSWORD", Value: "sensitive-value"},
			{Name: "X", ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: "credentials"}}}},
		},
	}}}, opts{annotations: map[string]string{
		"reflector.v1.k8s.emberstack.com/reflects":         "registry/source",
		"kubectl.kubernetes.io/last-applied-configuration": "sensitive",
		"arbitrary": "sensitive",
	}})
	raw, _ := json.Marshal(n)
	s := string(raw)
	if strings.Contains(s, "sensitive") || !strings.Contains(s, "credentials") || !strings.Contains(s, "app:1") {
		t.Errorf("projected = %s", s)
	}
	if !maps.Equal(n.Annotations, map[string]string{"reflector.v1.k8s.emberstack.com/reflects": "registry/source"}) {
		t.Errorf("annotations = %v", n.Annotations)
	}
}

func TestProjectCNPGKeepsExplicitReferencesOnly(t *testing.T) {
	n := cluster(t, "db", map[string]any{
		"certificates": map[string]any{"serverTLSSecret": "tls", "extra": "sensitive"},
		"monitoring":   map[string]any{"customQueriesConfigMap": []any{map[string]any{"name": "queries", "key": "sql", "extra": "sensitive"}}},
		"bootstrap":    map[string]any{"initdb": map[string]any{"password": "sensitive"}},
	}, opts{})
	eq(t, "secrets", n.Spec.ReferencedSecrets, []string{"tls"})
	eq(t, "configmaps", n.Spec.ReferencedConfigMaps, []string{"queries"})
	if raw, _ := json.Marshal(n); strings.Contains(string(raw), "sensitive") {
		t.Errorf("projected = %s", raw)
	}
}

func TestWorkloadJSONOmitsEmptyLists(t *testing.T) {
	raw, _ := json.Marshal(&Workload{Name: "a", Kind: "Deployment", Namespace: ns, Dependencies: Dependencies{Pods: []string{"p"}}})
	s := string(raw)
	if !strings.Contains(s, `"pods":["p"]`) || strings.Contains(s, "images") || strings.Contains(s, "standalonePods") ||
		strings.Contains(s, "orphaned") || strings.Contains(s, "ownerReferenceOnly") {
		t.Errorf("json = %s", s)
	}
}

func reflected(t *testing.T, kind, name string) *Node {
	return meta(t, kind, name, opts{annotations: map[string]string{"reflector.v1.k8s.emberstack.com/reflects": "registry/" + name}})
}

func shared(t *testing.T) []*Node {
	bundle := map[string]string{"trust.cert-manager.io/bundle": "trusted-ca-certs"}

	return []*Node{
		reflected(t, "Secret", "zot-registry-cluster-pull"),
		reflected(t, "ConfigMap", "shared-config"),
		meta(t, "Secret", "trusted-ca-certs", opts{labels: bundle}),
		meta(t, "ConfigMap", "trusted-ca-certs", opts{labels: bundle}),
		meta(t, "ConfigMap", "kube-root-ca.crt", opts{}),
		meta(t, "Secret", "sh.helm.release.v1.checkers.v73", opts{labels: map[string]string{"owner": "helm"}}),
	}
}

func TestSharedGeneratedResourcesOmittedFromOrphans(t *testing.T) {
	if w, _ := graph(t, shared(t)...); len(w) != 0 {
		t.Errorf("workloads = %+v", w)
	}
}

func TestSharedGeneratedResourcesKeptWhenConsumed(t *testing.T) {
	cm := func(name string) corev1.VolumeSource {
		return corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: name}}}
	}
	app := deployment(t, "app", corev1.PodSpec{
		ImagePullSecrets: []corev1.LocalObjectReference{{Name: "zot-registry-cluster-pull"}},
		Volumes: []corev1.Volume{
			{Name: "trust", VolumeSource: cm("trusted-ca-certs")},
			{Name: "config", VolumeSource: cm("shared-config")},
			{Name: "api-ca", VolumeSource: cm("kube-root-ca.crt")},
			{Name: "secret", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: "trusted-ca-certs"}}},
		},
	}, opts{})
	w, _ := graph(t, append([]*Node{app}, shared(t)...)...)
	if len(w) != 1 {
		t.Fatalf("workloads = %+v", w)
	}
	eq(t, "secrets", w[0].Secrets, []string{"trusted-ca-certs", "zot-registry-cluster-pull"})
	eq(t, "configmaps", w[0].ConfigMaps, []string{"kube-root-ca.crt", "shared-config", "trusted-ca-certs"})
}

func TestUnmarkedAndManagedObjectsStayOrphans(t *testing.T) {
	w, _ := graph(t,
		meta(t, "Secret", "zot-registry-cluster-pull", opts{}),
		meta(t, "Secret", "sh.helm.release.v1.fake.v1", opts{}),
		meta(t, "Secret", "app", opts{labels: map[string]string{"owner": "helm"}}),
		meta(t, "Secret", "tls", opts{labels: map[string]string{"controller.cert-manager.io/fao": "true"}}),
		meta(t, "ConfigMap", "app", opts{labels: map[string]string{"app.kubernetes.io/managed-by": "Helm"}}),
	)
	eq(t, "secrets", w[0].Secrets, []string{"app", "sh.helm.release.v1.fake.v1", "tls", "zot-registry-cluster-pull"})
	eq(t, "configmaps", w[0].ConfigMaps, []string{"app"})
}

func TestCNPGReferencesJoinCertificate(t *testing.T) {
	w, _ := graph(t,
		cluster(t, "database", map[string]any{
			"certificates": map[string]any{
				"serverTLSSecret": "database-tls", "serverCASecret": "database-tls",
				"clientCASecret": "client-ca", "replicationTLSSecret": "replication-tls",
			},
			"monitoring": map[string]any{
				"customQueriesConfigMap": []any{map[string]any{"name": "cnpg-default-monitoring", "key": "queries"}},
				"customQueriesSecret":    []any{map[string]any{"name": "private-queries", "key": "queries"}},
			},
		}, opts{}),
		pod(t, "database-1", corev1.PodSpec{}, opts{owners: []metav1.OwnerReference{ownerRef("Cluster", "database", CNPGSource.APIVersion())}}),
		certificate(t, "database", "database-tls"),
		meta(t, "Secret", "database-tls", opts{}),
		meta(t, "ConfigMap", "cnpg-default-monitoring", opts{}),
	)
	if len(w) != 1 {
		t.Fatalf("workloads = %+v", w)
	}
	c := w[0]
	if c.Kind != "Cluster" || c.Name != "database" || c.OwnerReferenceOnly {
		t.Errorf("root = %+v", c)
	}
	eq(t, "pods", c.Pods, []string{"database-1"})
	eq(t, "secrets", c.Secrets, []string{"client-ca", "database-tls", "private-queries", "replication-tls"})
	eq(t, "configmaps", c.ConfigMaps, []string{"cnpg-default-monitoring"})
	eq(t, "certificates", c.Certificates, []string{"database"})
}

func TestProjectRejectsIncompleteObjects(t *testing.T) {
	if _, err := Project(sourceFor(t, "Secret"), &corev1.Secret{ObjectMeta: objMeta("Secret", "s", opts{}), Data: map[string][]byte{"k": []byte("v")}}); err == nil {
		t.Error("full Secret accepted for a metadata-only source")
	}
	if _, err := Project(sourceFor(t, "Pod"), &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "p", UID: "u"}}); err == nil {
		t.Error("namespaceless pod accepted")
	}
	if _, err := Project(sourceFor(t, "Pod"), &metav1.PartialObjectMetadata{ObjectMeta: metav1.ObjectMeta{Name: "p", Namespace: ns, UID: "u"}}); err == nil {
		t.Error("metadata-only object accepted for full source")
	}
	n := project(t, "CronJob", &batchv1.CronJob{ObjectMeta: objMeta("CronJob", "c", opts{}),
		Spec: batchv1.CronJobSpec{JobTemplate: batchv1.JobTemplateSpec{Spec: batchv1.JobSpec{Template: corev1.PodTemplateSpec{
			Spec: corev1.PodSpec{Containers: []corev1.Container{{Image: "cron:1"}}}}}}}})
	eq(t, "cronjob images", n.Spec.Pod.Images, []string{"cron:1"})
}
