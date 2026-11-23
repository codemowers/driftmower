package mcpserver

import (
	"context"
	"fmt"
	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

type podProcessesInput struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	UID       string `json:"uid"`
}

func addPodProcessesTool(s *mcp.Server, w *Workloads, mapping auth.Mapping) {
	mcp.AddTool(s, &mcp.Tool{Name: "get_pod_processes", Title: "Read container root processes", Description: "Latest node-local root process observations for one Pod UID: arguments with common credential redaction, ELF linkage and host/inside UID/GID. No environment or process tree. Guest runtime host identity is unknown. Check observedAt for freshness.", InputSchema: inputSchema[podProcessesInput](nil), Annotations: readOnly("Read container root processes")}, func(ctx context.Context, req *mcp.CallToolRequest, in podProcessesInput) (*mcp.CallToolResult, map[string]any, error) {
		if in.Namespace == "" || in.Name == "" || in.UID == "" {
			return nil, nil, fmt.Errorf("namespace, name and UID required")
		}
		id, err := callerIdentity(req, mapping)
		if err != nil {
			return nil, nil, err
		}
		for _, a := range []authz.Attributes{{Namespace: in.Namespace, Resource: "pods", Name: in.Name, Verb: "get"}, {Namespace: in.Namespace, Group: "codemowers.io", Resource: "podprocesses", Name: "pod-" + in.UID, Verb: "get"}} {
			if w.Judge.MayPerform(ctx, id, a).Verdict != authz.Yes {
				return nil, nil, fmt.Errorf("not authorized to read this Pod's process observations")
			}
		}
		pods, err := w.Cache.Dynamic.Resource(schema.GroupVersionResource{Version: "v1", Resource: "pods"}).Namespace(in.Namespace).List(ctx, metav1.ListOptions{FieldSelector: fields.OneTermEqualSelector("metadata.name", in.Name).String()})
		if err != nil {
			return nil, nil, err
		}
		if len(pods.Items) != 1 || string(pods.Items[0].GetUID()) != in.UID {
			return nil, nil, fmt.Errorf("pod no longer exists or UID changed")
		}
		obj, err := w.Cache.Dynamic.Resource(schema.GroupVersionResource{Group: "codemowers.io", Version: "v1alpha1", Resource: "podprocesses"}).Namespace(in.Namespace).Get(ctx, "pod-"+in.UID, metav1.GetOptions{})
		if apierrors.IsNotFound(err) {
			return nil, map[string]any{"available": false, "reason": "No root process observation is available for this Pod"}, nil
		}
		if err != nil {
			return nil, nil, err
		}
		uid, _, _ := unstructured.NestedString(obj.Object, "spec", "podUID")
		name, _, _ := unstructured.NestedString(obj.Object, "spec", "podName")
		owned := false
		for _, owner := range obj.GetOwnerReferences() {
			if owner.Kind == "Pod" && string(owner.UID) == in.UID {
				owned = true
			}
		}
		if uid != in.UID || name != in.Name || !owned {
			return nil, nil, fmt.Errorf("process observation does not belong to this Pod")
		}
		observation, _, _ := unstructured.NestedMap(obj.Object, "observation")
		return nil, map[string]any{"available": true, "observation": observation}, nil
	})
}
