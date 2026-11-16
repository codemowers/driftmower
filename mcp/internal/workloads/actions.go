package workloads

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"

	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/catalog"
)

// RestartAdapter says how one workload kind is restarted. Adapters are
// explicit: unknown operators must not inherit rollout semantics.
type RestartAdapter struct {
	Resource       string
	AnnotationPath []string
	// The CRD whose served schema must expose the annotation map.
	CRD string
}

func RestartAdapterFor(apiVersion, kind string) (RestartAdapter, bool) {
	switch {
	case apiVersion == "apps/v1" && (kind == "Deployment" || kind == "StatefulSet" || kind == "DaemonSet"):
		return RestartAdapter{Resource: strings.ToLower(kind) + "s", AnnotationPath: []string{"spec", "template", "metadata", "annotations"}}, true
	case apiVersion == "postgresql.cnpg.io/v1" && kind == "Cluster":
		return RestartAdapter{Resource: "clusters", AnnotationPath: []string{"metadata", "annotations"}}, true
	case (apiVersion == "cluster.redpanda.com/v1alpha1" || apiVersion == "cluster.redpanda.com/v1alpha2") && kind == "Redpanda":
		return RestartAdapter{Resource: "redpandas", CRD: "redpandas.cluster.redpanda.com",
			AnnotationPath: []string{"spec", "clusterSpec", "statefulset", "podTemplate", "annotations"}}, true
	case apiVersion == "dragonflydb.io/v1alpha1" && kind == "Dragonfly":
		return RestartAdapter{Resource: "dragonflies", CRD: "dragonflies.dragonflydb.io", AnnotationPath: []string{"spec", "annotations"}}, true
	}

	return RestartAdapter{}, false
}

// Actions mutates workloads as the verified caller, through an impersonating
// client, so RBAC and admission apply to the caller and not to this server.
type Actions struct {
	// Bounded configuration of this server's own credentials.
	Config  *rest.Config
	Catalog *catalog.Catalog
	// Overridable in tests.
	clientFor func(authz.Identity) (dynamic.Interface, error)
	// This server's own credentials; built from Config when nil.
	serverClient dynamic.Interface
	now          func() time.Time
}

func (a *Actions) client(id authz.Identity) (dynamic.Interface, error) {
	if a.clientFor != nil {
		return a.clientFor(id)
	}
	cfg := rest.CopyConfig(a.Config)
	cfg.Impersonate = rest.ImpersonationConfig{UserName: id.User, Groups: id.Groups}

	return dynamic.NewForConfig(cfg)
}

type Target struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	UID       string `json:"uid"`
}

type RestartInput struct {
	Target
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
}

type ActionResult struct {
	Target
	APIVersion  string `json:"apiVersion,omitempty"`
	Kind        string `json:"kind,omitempty"`
	Action      string `json:"action"`
	RequestedAt string `json:"requestedAt,omitempty"`
	Status      string `json:"status"`
	Message     string `json:"message"`
}

func (a *Actions) current(ctx context.Context, res dynamic.ResourceInterface, t Target) (*unstructured.Unstructured, error) {
	obj, err := res.Get(ctx, t.Name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	if string(obj.GetUID()) != t.UID || obj.GetName() != t.Name || obj.GetNamespace() != t.Namespace {
		return nil, errors.New("workload identity changed; refresh inventory before trying again")
	}
	if obj.GetDeletionTimestamp() != nil {
		return nil, errors.New("object is already terminating")
	}

	return obj, nil
}

// Restart requests a rollout restart by stamping
// kubectl.kubernetes.io/restartedAt at the kind's annotation path. It returns
// request acceptance, not a completed rollout.
func (a *Actions) Restart(ctx context.Context, in RestartInput, id authz.Identity) (*ActionResult, error) {
	adapter, ok := RestartAdapterFor(in.APIVersion, in.Kind)
	if !ok {
		return nil, errors.New("this workload kind has no supported restart mechanism")
	}
	gv, err := schema.ParseGroupVersion(in.APIVersion)
	if err != nil {
		return nil, err
	}
	client, err := a.client(id)
	if err != nil {
		return nil, err
	}
	res := client.Resource(gv.WithResource(adapter.Resource)).Namespace(in.Namespace)
	obj, err := a.current(ctx, res, in.Target)
	if err != nil {
		return nil, err
	}

	spec := obj.Object
	flag := func(path ...string) bool { v, _, _ := unstructured.NestedBool(spec, path...); return v }
	str := func(path ...string) string { v, _, _ := unstructured.NestedString(spec, path...); return v }
	partition, _, _ := unstructured.NestedInt64(spec, "spec", "updateStrategy", "rollingUpdate", "partition")
	switch {
	case in.APIVersion == "apps/v1" && len(obj.GetOwnerReferences()) > 0:
		return nil, errors.New("restart the root workload owner instead of an owned controller")
	case flag("spec", "paused"):
		return nil, errors.New("deployment is paused; restart would not roll out")
	case str("spec", "updateStrategy", "type") == "OnDelete":
		return nil, errors.New("OnDelete workloads do not automatically roll out; restart is unsupported")
	case in.Kind == "StatefulSet" && partition > 0:
		return nil, errors.New("partitioned StatefulSet rollout would not restart every pod; restart is unsupported")
	case flag("spec", "suspend"):
		return nil, errors.New("operator reconciliation is suspended; restart would not roll out")
	case str("spec", "clusterSpec", "statefulset", "updateStrategy", "type") == "OnDelete":
		return nil, errors.New("Redpanda OnDelete updates do not automatically roll out; restart is unsupported") //nolint:staticcheck // Redpanda is a product name.
	}

	// Operator versions differ. Confirm the installed, served CRD exposes the
	// annotation map before sending a patch that could otherwise be pruned.
	if adapter.CRD != "" {
		if err := a.checkAnnotationSchema(ctx, adapter, gv.Version); err != nil {
			return nil, err
		}
	}

	requestedAt := a.clock().UTC().Format(time.RFC3339Nano)
	var patch any = map[string]any{"kubectl.kubernetes.io/restartedAt": requestedAt}
	for i := len(adapter.AnnotationPath) - 1; i >= 0; i-- {
		patch = map[string]any{adapter.AnnotationPath[i]: patch}
	}
	// uid and resourceVersion in a merge patch are preconditions: a stale
	// inventory or a concurrent change makes the API server refuse it.
	root := patch.(map[string]any)
	metadata, _ := root["metadata"].(map[string]any)
	if metadata == nil {
		metadata = map[string]any{}
	}
	metadata["uid"], metadata["resourceVersion"] = in.UID, obj.GetResourceVersion()
	root["metadata"] = metadata
	body, err := json.Marshal(root)
	if err != nil {
		return nil, err
	}
	if _, err := res.Patch(ctx, in.Name, types.MergePatchType, body, metav1.PatchOptions{}); err != nil {
		return nil, err
	}

	return &ActionResult{Target: in.Target, APIVersion: in.APIVersion, Kind: in.Kind, Action: "restart", RequestedAt: requestedAt, Status: "requested",
		Message: "Restart requested. Controller/operator reconciliation is asynchronous; completion and health are not verified."}, nil
}

func (a *Actions) clock() time.Time {
	if a.now != nil {
		return a.now()
	}

	return time.Now()
}

func (a *Actions) checkAnnotationSchema(ctx context.Context, adapter RestartAdapter, version string) error {
	if a.Catalog == nil {
		return errors.New("operator schema discovery is unavailable")
	}
	crd, err := a.Catalog.DescribeCRD(ctx, adapter.CRD)
	if err != nil {
		return err
	}
	var node map[string]any
	for _, v := range crd.Versions {
		if v.Name == version {
			node = v.Schema
		}
	}
	for _, field := range adapter.AnnotationPath {
		props, _ := node["properties"].(map[string]any)
		node, _ = props[field].(map[string]any)
	}
	additional, _ := node["additionalProperties"].(map[string]any)
	if node["type"] != "object" || additional["type"] != "string" {
		return errors.New("installed operator schema does not support this restart annotation path")
	}

	return nil
}

var podsGVR = schema.GroupVersionResource{Version: "v1", Resource: "pods"}

// Terminate deletes a standalone pod with its normal grace period, never
// forced. Owned and static mirror pods are refused: a controller would
// recreate the former, and the latter cannot be deleted this way.
func (a *Actions) Terminate(ctx context.Context, t Target, id authz.Identity) (*ActionResult, error) {
	client, err := a.client(id)
	if err != nil {
		return nil, err
	}
	res := client.Resource(podsGVR).Namespace(t.Namespace)
	obj, err := a.current(ctx, res, t)
	if err != nil {
		return nil, err
	}
	if len(obj.GetOwnerReferences()) > 0 {
		return nil, errors.New("only standalone pods may be terminated; this pod has an owner")
	}
	if _, mirror := obj.GetAnnotations()["kubernetes.io/config.mirror"]; mirror {
		return nil, errors.New("static mirror pods cannot be terminated through this endpoint")
	}
	uid, rv := types.UID(t.UID), obj.GetResourceVersion()
	if err := res.Delete(ctx, t.Name, metav1.DeleteOptions{Preconditions: &metav1.Preconditions{UID: &uid, ResourceVersion: &rv}}); err != nil {
		return nil, err
	}

	return &ActionResult{Target: t, Action: "terminate", Status: "requested",
		Message: "Pod termination requested with its normal grace period. A standalone pod has no controller to recreate it."}, nil
}

// OwnerRecord is what the dashboard shows of a custom-resource owner that
// is not watched.
type OwnerRecord struct {
	CreatedAt  *time.Time        `json:"createdAt,omitempty"`
	UpdatedAt  *time.Time        `json:"updatedAt,omitempty"`
	UpdatedBy  string            `json:"updatedBy,omitempty"`
	Provenance map[string]string `json:"provenance,omitempty"`
}

// Owner reads one object's metadata as the caller, so the caller's own get
// permission decides; uid rejects a replaced object.
func (a *Actions) Owner(ctx context.Context, id authz.Identity, gvr schema.GroupVersionResource, namespace, name, uid string) (*OwnerRecord, error) {
	client, err := a.client(id)
	if err != nil {
		return nil, err
	}
	obj, err := client.Resource(gvr).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	if uid != "" && string(obj.GetUID()) != uid {
		return nil, errors.New("the object was replaced")
	}
	n := &Node{ObjectMeta: reduceMeta(metav1.ObjectMeta{CreationTimestamp: obj.GetCreationTimestamp(), ManagedFields: obj.GetManagedFields(),
		Labels: obj.GetLabels(), Annotations: obj.GetAnnotations()})}
	out := &OwnerRecord{Provenance: provenance(n)}
	out.CreatedAt, out.UpdatedAt, out.UpdatedBy = times(n)

	return out, nil
}
