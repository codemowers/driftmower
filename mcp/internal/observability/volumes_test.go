package observability

import (
	"context"
	"encoding/json"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/codemowers/driftmower-mcp/internal/authz"
)

func volumeFixture() (*Service, *fake.Clientset, *judge, *fakeBackend) {
	class := "local"
	claim := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Namespace: "team", Name: "data"},
		Spec: corev1.PersistentVolumeClaimSpec{
			VolumeName: "pv-data", StorageClassName: &class, AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			Resources: corev1.VolumeResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse("8Gi")}},
		},
		Status: corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound, Capacity: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse("8Gi")}},
	}
	bound := &corev1.PersistentVolume{
		ObjectMeta: metav1.ObjectMeta{Name: "pv-data"},
		Spec: corev1.PersistentVolumeSpec{
			Capacity: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse("8Gi")},
			ClaimRef: &corev1.ObjectReference{Namespace: "team", Name: "data"},
			PersistentVolumeSource: corev1.PersistentVolumeSource{CSI: &corev1.CSIPersistentVolumeSource{
				Driver: "topolvm.io", VolumeAttributes: map[string]string{"private": "not-exported"},
				ControllerPublishSecretRef: &corev1.SecretReference{Name: "secret"},
			}},
		},
		Status: corev1.PersistentVolumeStatus{Phase: corev1.VolumeBound},
	}
	free := &corev1.PersistentVolume{
		ObjectMeta: metav1.ObjectMeta{Name: "free"},
		Spec:       corev1.PersistentVolumeSpec{Capacity: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse("2Gi")}},
		Status:     corev1.PersistentVolumeStatus{Phase: corev1.VolumeAvailable},
	}
	k := fake.NewClientset(claim, bound, free)
	j := &judge{}
	b := &fakeBackend{respond: func(*url.URL) (Response, error) {
		return vectorOf(map[string]any{"metric": map[string]string{"namespace": "team", "persistentvolumeclaim": "data"}, "value": []any{1, "100"}}), nil
	}}
	svc := &Service{PrometheusURL: "http://prometheus", Backend: b, Kubernetes: k, Judge: j, Now: func() time.Time { return usageT }}

	return svc, k, j, b
}

func reads(k *fake.Clientset) []string {
	var out []string
	for _, a := range k.Actions() {
		out = append(out, a.GetVerb()+" "+a.GetResource().Resource)
	}

	return out
}

func TestVolumesJoinClaimsPVsAndUsage(t *testing.T) {
	svc, k, j, _ := volumeFixture()
	res, err := svc.ListVolumes(context.Background(), alice, "team", false)
	if err != nil {
		t.Fatal(err)
	}
	c := res.Claims[0]
	if *c.BoundVolume != "pv-data" || *c.RequestedStorage != "8Gi" || *c.ProvisionedStorage != "8Gi" ||
		*c.Usage.UsedBytes != 100 || *c.Usage.CapacityBytes != 100 || *c.Usage.Inodes != 100 || *c.Usage.InodesUsed != 100 {
		t.Errorf("claim = %+v", c)
	}
	pv := res.PersistentVolumes[0]
	if pv.Name != "pv-data" || *pv.CapacityStorage != "8Gi" || *pv.CSIDriver != "topolvm.io" || *pv.Claim != (ClaimRef{"team", "data"}) {
		t.Errorf("pv = %+v", pv)
	}
	if !slices.Contains(j.asked, authz.Attributes{Namespace: "team", Resource: "persistentvolumeclaims", Verb: "list"}) ||
		!slices.Contains(j.asked, authz.Attributes{Resource: "persistentvolumes", Verb: "get", Name: "pv-data"}) {
		t.Errorf("asked = %+v", j.asked)
	}
	if !slices.Contains(reads(k), "get persistentvolumes") {
		t.Errorf("reads = %v", reads(k))
	}
	if len(res.MetricSources) != 4 {
		t.Errorf("sources = %+v", res.MetricSources)
	}
	for _, s := range res.MetricSources {
		if !strings.Contains(s.Query, "max by (namespace,persistentvolumeclaim)") || !strings.Contains(s.Query, `namespace="team"`) {
			t.Errorf("query = %s", s.Query)
		}
	}
	raw, _ := json.Marshal(res)
	if strings.Contains(string(raw), "not-exported") || strings.Contains(string(raw), "controllerPublishSecretRef") || strings.Contains(string(raw), `"name":"secret"`) {
		t.Error("CSI attributes or secret references exported")
	}
}

func TestVolumesWithoutPVPermission(t *testing.T) {
	svc, k, j, _ := volumeFixture()
	j.answer = func(_ authz.Identity, a authz.Attributes) authz.Verdict {
		if a.Resource == "persistentvolumes" {
			return authz.No
		}

		return authz.Yes
	}
	res, err := svc.ListVolumes(context.Background(), alice, "team", false)
	if err != nil {
		t.Fatal(err)
	}
	if *res.Claims[0].BoundVolume != "pv-data" || len(res.PersistentVolumes) != 0 || !strings.Contains(res.Degraded[0].Message, "caller lacks get") {
		t.Errorf("result = %+v", res)
	}
	for _, r := range reads(k) {
		if strings.Contains(r, "persistentvolumes") && !strings.Contains(r, "claims") {
			t.Errorf("PV read without permission: %v", reads(k))
		}
	}
}

func TestVolumesRefuseUnauthorizedListing(t *testing.T) {
	svc, k, j, b := volumeFixture()
	j.answer = deny
	if _, err := svc.ListVolumes(context.Background(), alice, "team", false); err == nil {
		t.Error("listing allowed")
	}
	if len(k.Actions()) != 0 || b.calls() != 0 {
		t.Errorf("reads %v, queries %d", reads(k), b.calls())
	}
}

func TestVolumesUnboundRequiresClusterPVList(t *testing.T) {
	svc, k, j, _ := volumeFixture()
	j.answer = func(_ authz.Identity, a authz.Attributes) authz.Verdict {
		if a.Resource == "persistentvolumes" && a.Verb == "list" {
			return authz.No
		}

		return authz.Yes
	}
	if _, err := svc.ListVolumes(context.Background(), alice, "team", true); err == nil || !strings.Contains(err.Error(), "cluster-wide list persistentvolumes") {
		t.Errorf("err = %v", err)
	}
	if len(k.Actions()) != 0 {
		t.Errorf("reads = %v", reads(k))
	}

	j.answer = nil
	res, err := svc.ListVolumes(context.Background(), alice, "", true)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, pv := range res.PersistentVolumes {
		names = append(names, pv.Name)
	}
	if !slices.Equal(names, []string{"free", "pv-data"}) {
		t.Errorf("pvs = %v", names)
	}
	if !slices.Contains(reads(k), "list persistentvolumeclaims") {
		t.Errorf("reads = %v", reads(k))
	}
}

func TestVolumesKeepInventoryWithoutMetrics(t *testing.T) {
	svc, _, _, b := volumeFixture()
	b.respond = func(*url.URL) (Response, error) { return Response{Status: 503, Body: []byte("unavailable")}, nil }
	res, err := svc.ListVolumes(context.Background(), alice, "team", false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Claims[0].Usage.UsedBytes != nil || len(res.Degraded) != 4 {
		t.Errorf("usage %+v, degraded %+v", res.Claims[0].Usage, res.Degraded)
	}

	b.respond = func(*url.URL) (Response, error) {
		return vectorOf(map[string]any{"metric": map[string]string{"namespace": "private", "persistentvolumeclaim": "secret-data"}, "value": []any{1, "100"}}), nil
	}
	res, err = svc.ListVolumes(context.Background(), alice, "team", false)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(res)
	if res.Claims[0].Usage.UsedBytes != nil || strings.Contains(string(raw), "secret-data") ||
		!strings.Contains(res.Degraded[0].Message, "outside the requested namespace") {
		t.Errorf("result = %s", raw)
	}

	svc.PrometheusURL = ""
	res, _ = svc.ListVolumes(context.Background(), alice, "team", false)
	if len(res.Degraded) != 1 || res.Degraded[0].Source != "prometheus" {
		t.Errorf("degraded = %+v", res.Degraded)
	}
}
