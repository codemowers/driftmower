package workloads

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
	metadatafake "k8s.io/client-go/metadata/fake"

	"github.com/codemowers/driftmower/mcp/internal/authz"
)

type judgeFunc func(authz.Identity, authz.Attributes) authz.Verdict

func (f judgeFunc) MayPerform(_ context.Context, id authz.Identity, a authz.Attributes) authz.Judgement {
	return authz.Judgement{Verdict: f(id, a)}
}

var alice = authz.Identity{User: "issuer#alice", Groups: []string{"system:authenticated"}}

// alice may list everything in team-a except Secrets, and nothing elsewhere.
var judge = judgeFunc(func(_ authz.Identity, a authz.Attributes) authz.Verdict {
	if a.Namespace == "team-a" && a.Resource != "secrets" {
		return authz.Yes
	}

	return authz.No
})

func controller(kind, name, uid string) []metav1.OwnerReference {
	yes := true
	apiVersion := "apps/v1"

	return []metav1.OwnerReference{{APIVersion: apiVersion, Kind: kind, Name: name, UID: types.UID(uid), Controller: &yes}}
}

func partial(kind, namespace, name, uid string) *metav1.PartialObjectMetadata {
	return &metav1.PartialObjectMetadata{
		TypeMeta:   metav1.TypeMeta{APIVersion: "v1", Kind: kind},
		ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name, UID: types.UID(uid)},
	}
}

func newCache(t *testing.T) (*Cache, *fake.Clientset) {
	t.Helper()
	labels := map[string]string{"app": "api"}
	k := fake.NewClientset(
		&appsv1.Deployment{
			ObjectMeta: metav1.ObjectMeta{Namespace: "team-a", Name: "api", UID: "d1"},
			Spec: appsv1.DeploymentSpec{Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec: corev1.PodSpec{Containers: []corev1.Container{{
					Image: "registry.example.com/api:1",
					Env:   []corev1.EnvVar{{Name: "PASSWORD", Value: "hunter2"}},
				}}},
			}},
		},
		&appsv1.ReplicaSet{
			ObjectMeta: metav1.ObjectMeta{Namespace: "team-a", Name: "api-1", UID: "r1", OwnerReferences: controller("Deployment", "api", "d1")},
			Spec:       appsv1.ReplicaSetSpec{Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: labels}}},
		},
		&corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Namespace: "team-a", Name: "api-1-x", UID: "p1", Labels: labels, OwnerReferences: controller("ReplicaSet", "api-1", "r1")},
			Spec: corev1.PodSpec{
				Containers: []corev1.Container{{Image: "registry.example.com/api:1"}},
				Volumes:    []corev1.Volume{{Name: "config", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: "api-config"}}}}},
			},
		},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: "team-a", Name: "api", UID: "s1"}, Spec: corev1.ServiceSpec{Selector: labels}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "team-b", Name: "other", UID: "p9"}},
	)

	scheme := metadatafake.NewTestScheme()
	if err := metav1.AddMetaToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	meta := metadatafake.NewSimpleMetadataClient(scheme,
		partial("ConfigMap", "team-a", "api-config", "c1"),
		partial("ConfigMap", "team-a", "unused", "c2"),
		partial("ConfigMap", "team-a", "kube-root-ca.crt", "c3"),
		partial("Secret", "team-a", "db", "x1"),
	)

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	c := &Cache{
		Kubernetes: k,
		Metadata:   meta,
		Dynamic:    dynamicfake.NewSimpleDynamicClient(runtime.NewScheme()),
		Discovery:  k.Discovery(),
		Judge:      judge,
		Scope: &authz.ScopeResolver{
			ListNamespaces: func(context.Context) ([]string, error) { return []string{"team-a", "team-b"}, nil },
			Judge:          judge,
		},
		Logger: slog.New(slog.DiscardHandler),
	}
	c.Start(ctx)

	return c, k
}

func TestCacheInventory(t *testing.T) {
	c, k := newCache(t)

	inv, err := c.List(context.Background(), "team-a", alice)
	if err != nil {
		t.Fatal(err)
	}
	var api, bucket *Workload
	for _, w := range inv.Workloads {
		switch w.Kind {
		case "Deployment":
			api = w
		case "Namespace":
			bucket = w
		}
	}
	if api == nil || !slices.Equal(api.Pods, []string{"api-1-x"}) || !slices.Equal(api.Images, []string{"registry.example.com/api:1"}) ||
		!slices.Equal(api.ConfigMaps, []string{"api-config"}) || !slices.Equal(api.Services, []string{"api"}) {
		t.Fatalf("api = %+v", api)
	}
	// Secrets are withheld from the caller, and kube-root-ca.crt is never an
	// orphan.
	if bucket == nil || !slices.Equal(bucket.ConfigMaps, []string{"unused"}) || len(bucket.Secrets) != 0 {
		t.Errorf("orphan bucket = %+v", bucket)
	}
	if !slices.Contains(inv.Warnings, "team-a: list secrets is not authorized; related inventory may be incomplete.") {
		t.Errorf("warnings = %v", inv.Warnings)
	}
	if !strings.Contains(inv.Revision, ":") {
		t.Errorf("revision = %q", inv.Revision)
	}

	// A new standalone pod appears once its watch event is delivered.
	before := inv.Revision
	if _, err := k.CoreV1().Pods("team-a").Create(context.Background(), &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: "team-a", Name: "debug", UID: "p2"},
	}, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		inv, err = c.List(context.Background(), "team-a", alice)
		if err != nil {
			t.Fatal(err)
		}
		bucket = inv.Workloads[slices.IndexFunc(inv.Workloads, func(w *Workload) bool { return w.Kind == "Namespace" })]
		if len(bucket.StandalonePods) == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("standalone pod never appeared: %+v", bucket)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if bucket.StandalonePods[0] != (StandalonePod{Name: "debug", UID: "p2"}) || inv.Revision == before {
		t.Errorf("standalone = %+v, revision %s -> %s", bucket.StandalonePods, before, inv.Revision)
	}
}

// A collection the server's own service account may not watch is never
// started: nothing retries against a 403, references from pod specs are still
// reported, and every answer names the gap.
func TestCacheSkipsWatchesItMayNotPerform(t *testing.T) {
	c, _ := newCache(t)
	c.MayWatch = func(_ context.Context, gvr schema.GroupVersionResource) (bool, error) {
		switch gvr.Resource {
		case "configmaps":
			return false, nil
		case "services":
			return false, errors.New("SelfSubjectAccessReview failed")
		}

		return true, nil
	}

	inv, err := c.List(context.Background(), "team-a", alice)
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range c.targets {
		switch target.source.GVR.Resource {
		case "configmaps":
			if target.informer != nil {
				t.Error("configmaps are watched although the service account may not")
			}
		case "services":
			if target.informer == nil {
				t.Error("services are not watched although the permission check only failed")
			}
		}
	}
	api := inv.Workloads[slices.IndexFunc(inv.Workloads, func(w *Workload) bool { return w.Kind == "Deployment" })]
	if !slices.Equal(api.ConfigMaps, []string{"api-config"}) || !slices.Equal(api.Services, []string{"api"}) {
		t.Errorf("api = %+v", api)
	}
	// Empty orphan buckets are omitted.
	if i := slices.IndexFunc(inv.Workloads, func(w *Workload) bool { return w.Kind == "Namespace" }); i >= 0 && len(inv.Workloads[i].ConfigMaps) != 0 {
		t.Errorf("orphaned configmaps from an unwatched collection: %v", inv.Workloads[i].ConfigMaps)
	}
	want := "team-a: configmaps are not watched: this server's service account is not granted cluster-wide list and watch on them. " +
		"Names that pods reference are still reported; unreferenced objects are missing from orphan classification."
	if !slices.Contains(inv.Warnings, want) {
		t.Errorf("warnings = %q", inv.Warnings)
	}
}

func TestCacheWithholdsNamespacesAndScopes(t *testing.T) {
	c, _ := newCache(t)

	inv, err := c.List(context.Background(), "team-b", alice)
	if err != nil {
		t.Fatal(err)
	}
	if len(inv.Workloads) != 0 || !slices.Equal(inv.Warnings, []string{"team-b: list pods is not authorized; inventory withheld."}) {
		t.Errorf("team-b = %+v", inv)
	}

	// Without a namespace, only the caller's visible namespaces are read.
	inv, err = c.List(context.Background(), "", alice)
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range inv.Workloads {
		if w.Namespace != "team-a" {
			t.Errorf("workload outside scope: %+v", w)
		}
	}
}

func TestProjectedObjectsKeepNoValues(t *testing.T) {
	c, _ := newCache(t)
	if _, err := c.List(context.Background(), "team-a", alice); err != nil {
		t.Fatal(err)
	}
	for _, target := range c.targets {
		for _, obj := range target.informer.GetStore().List() {
			n, ok := obj.(*Node)
			if !ok {
				t.Fatalf("%s stored %T", target.source.GVR.Resource, obj)
			}
			if strings.Contains(strings.Join(n.Spec.Pod.allValues(), " "), "hunter2") {
				t.Errorf("env value cached for %s", n.Name)
			}
		}
	}
	if len(c.targets) != len(Sources) {
		t.Errorf("targets = %d; optional CRD adapters must not start without their APIs", len(c.targets))
	}
}

func (p *PodRefs) allValues() []string {
	if p == nil {
		return nil
	}

	return slices.Concat(p.Images, p.ConfigMaps, p.Secrets, p.PVCs, p.EphemeralVolumes)
}
