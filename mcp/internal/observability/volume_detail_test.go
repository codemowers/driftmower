package observability

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/codemowers/driftmower/mcp/internal/authz"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

func TestVolumeDetailsPreferExistingClaimAndDetectGoneClaim(t *testing.T) {
	s, k, _, _ := volumeFixture()
	detail, err := s.GetVolume(context.Background(), alice, VolumeDetailInput{Volume: "pv-data"})
	if err != nil || detail.ClaimState != "exists" || detail.Claim == nil || detail.Claim.Name != "data" {
		t.Fatalf("PV did not resolve existing PVC: %+v %v", detail, err)
	}
	body, _ := json.Marshal(detail)
	if strings.Contains(string(body), "not-exported") || strings.Contains(string(body), "ControllerPublishSecretRef") {
		t.Fatal("CSI private metadata leaked")
	}
	if err := k.CoreV1().PersistentVolumeClaims("team").Delete(context.Background(), "data", metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	detail, err = s.GetVolume(context.Background(), alice, VolumeDetailInput{Namespace: "team", Claim: "data", Volume: "pv-data"})
	if err != nil || detail.ClaimState != "missing" || detail.Claim != nil || detail.PersistentVolume == nil {
		t.Fatalf("missing claim did not fall back to PV: %+v %v", detail, err)
	}
}

func TestVolumeDetailsDoNotTreatDeniedClaimAsMissing(t *testing.T) {
	s, k, j, _ := volumeFixture()
	j.answer = func(_ authz.Identity, a authz.Attributes) authz.Verdict {
		if a.Resource == "persistentvolumeclaims" {
			return authz.No
		}
		return authz.Yes
	}
	detail, err := s.GetVolume(context.Background(), alice, VolumeDetailInput{Volume: "pv-data"})
	if err != nil || detail.ClaimState != "unknown" || detail.Claim != nil {
		t.Fatalf("denied claim reported absent: %+v %v", detail, err)
	}
	for _, a := range k.Actions() {
		if a.GetResource().Resource == "persistentvolumeclaims" {
			t.Fatal("denied PVC was queried with server credentials")
		}
	}
}

func TestVolumeDetailsDoNotTargetReplacementClaim(t *testing.T) {
	s, k, _, _ := volumeFixture()
	pv, err := k.CoreV1().PersistentVolumes().Get(context.Background(), "pv-data", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	pv.Spec.ClaimRef.UID = types.UID("old-claim")
	if _, err := k.CoreV1().PersistentVolumes().Update(context.Background(), pv, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	claim, err := k.CoreV1().PersistentVolumeClaims("team").Get(context.Background(), "data", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	claim.UID = types.UID("new-claim")
	claim.Spec.VolumeName = "other-pv"
	if _, err := k.CoreV1().PersistentVolumeClaims("team").Update(context.Background(), claim, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	detail, err := s.GetVolume(context.Background(), alice, VolumeDetailInput{Volume: "pv-data"})
	if err != nil || detail.Claim != nil || detail.ClaimState != "replaced" {
		t.Fatalf("replacement PVC was targeted: %+v %v", detail, err)
	}
	// A direct request for the new PVC must follow its own binding, ignoring
	// a stale PV locator supplied in the URL.
	if _, err := k.CoreV1().PersistentVolumes().Create(context.Background(), &corev1.PersistentVolume{ObjectMeta: metav1.ObjectMeta{Name: "other-pv"}}, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	detail, err = s.GetVolume(context.Background(), alice, VolumeDetailInput{Namespace: "team", Claim: "data", Volume: "pv-data"})
	if err != nil || detail.PersistentVolume == nil || detail.PersistentVolume.Name != "other-pv" {
		t.Fatalf("stale locator overrode live binding: %+v %v", detail, err)
	}
}
