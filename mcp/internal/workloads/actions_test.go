package workloads

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/codemowers/driftmower-mcp/internal/authz"
)

func object(apiVersion, kind, name string, fields map[string]any) *unstructured.Unstructured {
	meta := map[string]any{"namespace": "team-a", "name": name, "uid": name + "-uid", "resourceVersion": "7"}
	if m, ok := fields["metadata"].(map[string]any); ok {
		for k, v := range m {
			meta[k] = v
		}
	}
	fields["metadata"] = meta
	fields["apiVersion"], fields["kind"] = apiVersion, kind

	return &unstructured.Unstructured{Object: fields}
}

func actions(t *testing.T, objects ...runtime.Object) (*Actions, *dynamicfake.FakeDynamicClient, *authz.Identity) {
	t.Helper()
	client := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{
		{Group: "apps", Version: "v1", Resource: "deployments"}:  "DeploymentList",
		{Group: "apps", Version: "v1", Resource: "statefulsets"}: "StatefulSetList",
		{Version: "v1", Resource: "pods"}:                        "PodList",
	}, objects...)
	var seen authz.Identity
	a := &Actions{
		clientFor: func(id authz.Identity) (dynamic.Interface, error) { seen = id; return client, nil },
		now:       func() time.Time { return time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC) },
	}

	return a, client, &seen
}

func restartTarget(kind, name string) RestartInput {
	return RestartInput{Target: Target{Namespace: "team-a", Name: name, UID: name + "-uid"}, APIVersion: "apps/v1", Kind: kind}
}

func TestRestartPatchesWithPreconditions(t *testing.T) {
	a, client, seen := actions(t, object("apps/v1", "Deployment", "api", map[string]any{"spec": map[string]any{}}))
	var patch map[string]any
	client.PrependReactor("patch", "deployments", func(action k8stesting.Action) (bool, runtime.Object, error) {
		_ = json.Unmarshal(action.(k8stesting.PatchAction).GetPatch(), &patch)

		return false, nil, nil
	})

	result, err := a.Restart(context.Background(), restartTarget("Deployment", "api"), alice)
	if err != nil {
		t.Fatal(err)
	}
	if seen.User != alice.User {
		t.Errorf("acted as %+v, want the caller", seen)
	}
	if result.Status != "requested" || result.RequestedAt != "2026-10-28T12:00:00Z" || !strings.HasPrefix(result.Message, "Restart requested.") {
		t.Errorf("result = %+v", result)
	}
	want := `{"metadata":{"resourceVersion":"7","uid":"api-uid"},"spec":{"template":{"metadata":{"annotations":{"kubectl.kubernetes.io/restartedAt":"2026-10-28T12:00:00Z"}}}}}`
	if got, _ := json.Marshal(patch); string(got) != want {
		t.Errorf("patch = %s\nwant %s", got, want)
	}
}

func TestRestartRefusals(t *testing.T) {
	cases := map[string]struct {
		obj   *unstructured.Unstructured
		input RestartInput
		want  string
	}{
		"stale uid": {object("apps/v1", "Deployment", "api", map[string]any{}),
			RestartInput{Target: Target{Namespace: "team-a", Name: "api", UID: "other"}, APIVersion: "apps/v1", Kind: "Deployment"}, "identity changed"},
		"owned": {object("apps/v1", "Deployment", "api", map[string]any{"metadata": map[string]any{
			"ownerReferences": []any{map[string]any{"apiVersion": "x/v1", "kind": "X", "name": "x", "uid": "u"}}}}),
			restartTarget("Deployment", "api"), "root workload owner"},
		"paused": {object("apps/v1", "Deployment", "api", map[string]any{"spec": map[string]any{"paused": true}}),
			restartTarget("Deployment", "api"), "paused"},
		"on delete": {object("apps/v1", "StatefulSet", "db", map[string]any{"spec": map[string]any{"updateStrategy": map[string]any{"type": "OnDelete"}}}),
			restartTarget("StatefulSet", "db"), "OnDelete"},
		"partitioned": {object("apps/v1", "StatefulSet", "db", map[string]any{"spec": map[string]any{"updateStrategy": map[string]any{"rollingUpdate": map[string]any{"partition": int64(2)}}}}),
			restartTarget("StatefulSet", "db"), "Partitioned"},
		"terminating": {object("apps/v1", "Deployment", "api", map[string]any{"metadata": map[string]any{"deletionTimestamp": "2026-10-28T00:00:00Z"}}),
			restartTarget("Deployment", "api"), "already terminating"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			a, _, _ := actions(t, tc.obj)
			if _, err := a.Restart(context.Background(), tc.input, alice); err == nil || !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(tc.want)) {
				t.Errorf("err = %v, want %q", err, tc.want)
			}
		})
	}

	a, _, _ := actions(t)
	if _, err := a.Restart(context.Background(), RestartInput{APIVersion: "batch/v1", Kind: "Job"}, alice); err == nil {
		t.Error("Job restart accepted")
	}
	// Operator adapters require the installed schema to be checked.
	if _, err := a.Restart(context.Background(), RestartInput{Target: Target{Namespace: "team-a", Name: "cache", UID: "cache-uid"},
		APIVersion: "dragonflydb.io/v1alpha1", Kind: "Dragonfly"}, alice); err == nil {
		t.Error("Dragonfly restart accepted without schema discovery")
	}
}

func TestTerminate(t *testing.T) {
	a, client, _ := actions(t,
		object("v1", "Pod", "debug", map[string]any{}),
		object("v1", "Pod", "owned", map[string]any{"metadata": map[string]any{
			"ownerReferences": []any{map[string]any{"apiVersion": "batch/v1", "kind": "Job", "name": "j", "uid": "u"}}}}),
		object("v1", "Pod", "static", map[string]any{"metadata": map[string]any{"annotations": map[string]any{"kubernetes.io/config.mirror": "x"}}}),
	)
	var deleted k8stesting.DeleteActionImpl
	client.PrependReactor("delete", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
		deleted = action.(k8stesting.DeleteActionImpl)

		return false, nil, nil
	})

	result, err := a.Terminate(context.Background(), Target{Namespace: "team-a", Name: "debug", UID: "debug-uid"}, alice)
	if err != nil {
		t.Fatal(err)
	}
	pre := deleted.DeleteOptions.Preconditions
	if result.Action != "terminate" || pre == nil || string(*pre.UID) != "debug-uid" || *pre.ResourceVersion != "7" || deleted.DeleteOptions.GracePeriodSeconds != nil {
		t.Errorf("result %+v, delete %+v", result, deleted.DeleteOptions)
	}

	for name, want := range map[string]string{"owned": "has an owner", "static": "mirror"} {
		if _, err := a.Terminate(context.Background(), Target{Namespace: "team-a", Name: name, UID: name + "-uid"}, alice); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
}
