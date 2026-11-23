package mcpserver

import (
	"context"
	"errors"
	"fmt"

	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

type objectInput struct {
	Namespace string `json:"namespace"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	UID       string `json:"uid,omitempty"`
}

func addWorkloadObjectTool(s *mcp.Server, w *Workloads, mapping auth.Mapping) {
	mcp.AddTool(s, &mcp.Tool{Name: "get_workload_object", Title: "Read workload object", Description: "One Pod, Deployment, ReplicaSet, StatefulSet or DaemonSet object. Pass uid to reject a replaced object.", InputSchema: inputSchema[objectInput](nil), Annotations: readOnly("Read workload object")}, func(ctx context.Context, req *mcp.CallToolRequest, in objectInput) (*mcp.CallToolResult, map[string]any, error) {
		id, err := callerIdentity(req, mapping)
		if err != nil {
			return nil, nil, err
		}
		resources := map[string]schema.GroupVersionResource{
			"Pod":         {Version: "v1", Resource: "pods"},
			"Deployment":  {Group: "apps", Version: "v1", Resource: "deployments"},
			"ReplicaSet":  {Group: "apps", Version: "v1", Resource: "replicasets"},
			"StatefulSet": {Group: "apps", Version: "v1", Resource: "statefulsets"},
			"DaemonSet":   {Group: "apps", Version: "v1", Resource: "daemonsets"},
		}
		gvr, ok := resources[in.Kind]
		if !ok || in.Namespace == "" || in.Name == "" {
			return nil, nil, errors.New("supported kind, namespace and name are required")
		}
		if w.Judge.MayPerform(ctx, id, authz.Attributes{Namespace: in.Namespace, Group: gvr.Group, Resource: gvr.Resource, Name: in.Name, Verb: "get"}).Verdict != authz.Yes {
			return nil, nil, errors.New("not authorized to read this workload")
		}
		// The service account may list these kinds but not get them.
		list, err := w.Cache.Dynamic.Resource(gvr).Namespace(in.Namespace).List(ctx, metav1.ListOptions{FieldSelector: fields.OneTermEqualSelector("metadata.name", in.Name).String()})
		if err != nil {
			return nil, nil, err
		}
		if len(list.Items) != 1 {
			return nil, nil, fmt.Errorf("%s %s/%s not found", in.Kind, in.Namespace, in.Name)
		}
		obj := &list.Items[0]
		if in.UID != "" && string(obj.GetUID()) != in.UID {
			return nil, nil, errors.New("workload UID changed")
		}
		return nil, obj.Object, nil
	})
}
