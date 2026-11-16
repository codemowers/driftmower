package workloads

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"

	"github.com/codemowers/driftmower/mcp/internal/authz"
)

var (
	pvcGVR          = schema.GroupVersionResource{Version: "v1", Resource: "persistentvolumeclaims"}
	storageClassGVR = schema.GroupVersionResource{Group: "storage.k8s.io", Version: "v1", Resource: "storageclasses"}
)

type ExpandInput struct {
	Target
	// The absolute storage request to set, as a Kubernetes quantity.
	Storage string `json:"storage"`
}

type ExpandResult struct {
	ActionResult
	From string `json:"from"`
	To   string `json:"to"`
}

// Expand raises a Bound claim's storage request to an absolute size, so a
// repeated submission of the same size is a no-op rather than a second
// growth. The size may at most double the current request, and the
// StorageClass must allow expansion; the CSI driver resizes asynchronously.
func (a *Actions) Expand(ctx context.Context, in ExpandInput, id authz.Identity) (*ExpandResult, error) {
	target, err := resource.ParseQuantity(in.Storage)
	if err != nil || target.Sign() <= 0 {
		return nil, errors.New("storage must be a positive Kubernetes quantity")
	}
	client, err := a.client(id)
	if err != nil {
		return nil, err
	}
	res := client.Resource(pvcGVR).Namespace(in.Namespace)
	obj, err := a.current(ctx, res, in.Target)
	if err != nil {
		return nil, err
	}
	requested, _, _ := unstructured.NestedString(obj.Object, "spec", "resources", "requests", "storage")
	current, err := resource.ParseQuantity(requested)
	if err != nil {
		return nil, errors.New("claim has no valid storage request")
	}
	result := &ExpandResult{ActionResult: ActionResult{Target: in.Target, Action: "expand"}, From: current.String(), To: current.String()}
	if target.Cmp(current) <= 0 {
		result.Status, result.Message = "unchanged", fmt.Sprintf("Storage request is already %s; volumes cannot shrink, so nothing was changed.", current.String())

		return result, nil
	}
	limit := current.DeepCopy()
	limit.Add(current)
	if target.Cmp(limit) > 0 {
		return nil, fmt.Errorf("storage %s more than doubles the current request %s", target.String(), current.String())
	}
	if phase, _, _ := unstructured.NestedString(obj.Object, "status", "phase"); phase != "Bound" {
		return nil, errors.New("only Bound claims can be expanded")
	}
	className, _, _ := unstructured.NestedString(obj.Object, "spec", "storageClassName")
	if className == "" {
		return nil, errors.New("claim has no StorageClass; expansion is unsupported")
	}
	allowed, err := a.classAllowsExpansion(ctx, className)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, fmt.Errorf("StorageClass %s does not allow volume expansion", className)
	}

	// The UID guards against a replaced claim. resourceVersion is left out:
	// the absolute size already makes a concurrent repeat harmless.
	patch, err := json.Marshal(map[string]any{
		"metadata": map[string]any{"uid": in.UID},
		"spec":     map[string]any{"resources": map[string]any{"requests": map[string]any{"storage": target.String()}}},
	})
	if err != nil {
		return nil, err
	}
	if _, err := res.Patch(ctx, in.Name, types.MergePatchType, patch, metav1.PatchOptions{}); err != nil {
		return nil, err
	}
	result.To, result.Status = target.String(), "requested"
	result.Message = fmt.Sprintf("Storage request raised from %s to %s. The CSI driver resizes asynchronously; some drivers finish the filesystem resize only when a Pod mounts the claim.", current.String(), target.String())

	return result, nil
}

// classAllowsExpansion reads StorageClasses with this server's own list
// permission: callers who may patch a claim commonly cannot read classes.
func (a *Actions) classAllowsExpansion(ctx context.Context, name string) (bool, error) {
	client := a.serverClient
	if client == nil {
		c, err := dynamic.NewForConfig(a.Config)
		if err != nil {
			return false, err
		}
		client = c
	}
	list, err := client.Resource(storageClassGVR).List(ctx, metav1.ListOptions{})
	if err != nil {
		return false, fmt.Errorf("StorageClasses are unavailable: %w", err)
	}
	for _, c := range list.Items {
		if c.GetName() == name {
			allowed, _, _ := unstructured.NestedBool(c.Object, "allowVolumeExpansion")

			return allowed, nil
		}
	}

	return false, fmt.Errorf("StorageClass %s not found", name)
}
