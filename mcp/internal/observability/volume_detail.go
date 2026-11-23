package observability

import (
	"context"
	"errors"
	"fmt"

	"github.com/codemowers/driftmower/mcp/internal/authz"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type VolumeDetailInput struct {
	Namespace string `json:"namespace,omitempty"`
	Claim     string `json:"claim,omitempty"`
	Volume    string `json:"volume,omitempty"`
}

type VolumeDetail struct {
	Claim            *Claim            `json:"claim"`
	PersistentVolume *PersistentVolume `json:"persistentVolume"`
	StorageClass     *StorageClassInfo `json:"storageClass"`
	// missing is established by a Kubernetes NotFound, never by lack of access.
	ClaimState string   `json:"claimState"`
	Warnings   []string `json:"warnings"`
}

func describeClaim(c *corev1.PersistentVolumeClaim) Claim {
	claim := Claim{ResizeStatus: c.Status.AllocatedResourceStatuses[corev1.ResourceStorage], CreatedAt: c.CreationTimestamp.Time, Namespace: c.Namespace, Name: c.Name, UID: string(c.UID), Phase: optional(string(c.Status.Phase)), StorageClass: c.Spec.StorageClassName, RequestedStorage: quantity(c.Spec.Resources.Requests, corev1.ResourceStorage), ProvisionedStorage: quantity(c.Status.Capacity, corev1.ResourceStorage), VolumeMode: volumeMode(c.Spec.VolumeMode), AccessModes: modes(c.Spec.AccessModes), BoundVolume: optional(c.Spec.VolumeName), UsedBy: []PodRef{}}
	for _, condition := range c.Status.Conditions {
		claim.Conditions = append(claim.Conditions, ClaimCondition{Type: string(condition.Type), Status: string(condition.Status), Message: condition.Message, LastTransitionTime: condition.LastTransitionTime.Time})
	}
	return claim
}

// GetVolume reads one binding, checking the caller's get permission for each
// object. It resolves a PV's live claim before allowing UI commands to prefer
// that claim; a stale claimRef cannot target an unrelated replacement PVC.
func (s *Service) GetVolume(ctx context.Context, id authz.Identity, in VolumeDetailInput) (*VolumeDetail, error) {
	if (in.Claim == "" && in.Volume == "") || (in.Claim != "" && in.Namespace == "") {
		return nil, errors.New("provide a PV name or a PVC name and namespace")
	}
	out := &VolumeDetail{ClaimState: "unbound", Warnings: []string{}}
	volumeName := in.Volume
	if in.Claim != "" {
		if s.Judge.MayPerform(ctx, id, authz.Attributes{Namespace: in.Namespace, Resource: "persistentvolumeclaims", Verb: "get", Name: in.Claim}).Verdict != authz.Yes {
			return nil, errors.New("kubernetes RBAC denied get persistentvolumeclaim")
		}
		claim, err := s.Kubernetes.CoreV1().PersistentVolumeClaims(in.Namespace).Get(ctx, in.Claim, metav1.GetOptions{})
		if apierrors.IsNotFound(err) {
			out.ClaimState = "missing"
		} else if err != nil {
			return nil, err
		} else {
			value := describeClaim(claim)
			out.Claim = &value
			out.ClaimState = "exists"
			volumeName = claim.Spec.VolumeName
		}
	}
	if volumeName != "" {
		if s.Judge.MayPerform(ctx, id, authz.Attributes{Resource: "persistentvolumes", Verb: "get", Name: volumeName}).Verdict != authz.Yes {
			if out.Claim == nil {
				return nil, errors.New("kubernetes RBAC denied get persistentvolume")
			}
			out.Warnings = append(out.Warnings, "PV details unavailable: caller lacks get permission")
		} else {
			pv, err := s.Kubernetes.CoreV1().PersistentVolumes().Get(ctx, volumeName, metav1.GetOptions{})
			if apierrors.IsNotFound(err) {
				out.Warnings = append(out.Warnings, "The PersistentVolume no longer exists")
			} else if err != nil {
				return nil, err
			} else {
				value := describePV(pv)
				out.PersistentVolume = &value
				if out.Claim == nil && pv.Spec.ClaimRef != nil {
					ref := pv.Spec.ClaimRef
					if s.Judge.MayPerform(ctx, id, authz.Attributes{Namespace: ref.Namespace, Resource: "persistentvolumeclaims", Verb: "get", Name: ref.Name}).Verdict != authz.Yes {
						out.ClaimState = "unknown"
						out.Warnings = append(out.Warnings, "Claim existence cannot be checked: caller lacks get PVC permission. PV-only deletion is not offered.")
					} else {
						claim, err := s.Kubernetes.CoreV1().PersistentVolumeClaims(ref.Namespace).Get(ctx, ref.Name, metav1.GetOptions{})
						if apierrors.IsNotFound(err) {
							out.ClaimState = "missing"
						} else if err != nil {
							return nil, err
						} else if (ref.UID != "" && ref.UID != claim.UID) || (claim.Spec.VolumeName != "" && claim.Spec.VolumeName != pv.Name) {
							out.ClaimState = "replaced"
							out.Warnings = append(out.Warnings, "The old claim was replaced or now belongs to another PV; commands will not target that PVC.")
						} else if ref.UID == "" && claim.Spec.VolumeName != pv.Name {
							out.ClaimState = "unknown"
							out.Warnings = append(out.Warnings, "The claimRef has no UID and the PVC is not bound to this PV; its identity is unverified.")
						} else {
							c := describeClaim(claim)
							out.Claim = &c
							out.ClaimState = "exists"
						}
					}
				}
			}
		}
	}
	var className *string
	if out.Claim != nil {
		className = out.Claim.StorageClass
	} else if out.PersistentVolume != nil {
		className = out.PersistentVolume.StorageClass
	}
	if className != nil && *className != "" {
		// As in list_volumes, StorageClass capabilities are public metadata;
		// CSI Secret references are removed by describeStorageClass.
		class, err := s.Kubernetes.StorageV1().StorageClasses().Get(ctx, *className, metav1.GetOptions{})
		if err != nil {
			out.Warnings = append(out.Warnings, fmt.Sprintf("StorageClass details unavailable: %v", err))
		} else {
			value := describeStorageClass(class)
			out.StorageClass = &value
		}
	}
	if out.Claim != nil {
		if s.ExpandEnabled && out.StorageClass != nil && out.StorageClass.AllowVolumeExpansion && out.Claim.Phase != nil && *out.Claim.Phase == "Bound" {
			out.Claim.CanExpand = s.Judge.MayPerform(ctx, id, authz.Attributes{Namespace: out.Claim.Namespace, Resource: "persistentvolumeclaims", Verb: "patch", Name: out.Claim.Name}).Verdict == authz.Yes
		}
		claims := []Claim{*out.Claim}
		s.markUsedBy(ctx, id, out.Claim.Namespace, claims, func(source, message string) { out.Warnings = append(out.Warnings, source+": "+message) })
		out.Claim = &claims[0]
	}
	return out, nil
}
