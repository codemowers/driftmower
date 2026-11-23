package scanner

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
	ktesting "k8s.io/client-go/testing"
	"k8s.io/client-go/tools/cache"
)

const testRef = "registry/app@sha256:target"

func testNode(name string) *corev1.Node {
	return &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: name, Labels: map[string]string{"kubernetes.io/hostname": name, "kubernetes.io/arch": "amd64"}}, Status: corev1.NodeStatus{
		Conditions: []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionTrue}},
		Images:     []corev1.ContainerImage{{Names: []string{testRef}}},
	}}
}

func testController(t *testing.T, count int) (*Controller, *unstructured.Unstructured, string) {
	t.Helper()
	image := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "codemowers.io/v1alpha1", "kind": "ContainerImage",
		"metadata":    map[string]any{"name": "image", "uid": "image-uid"},
		"repoDigests": []any{testRef}, "manifests": []any{map[string]any{"architecture": "amd64", "digest": "sha256:target"}},
		"nodes": []any{map[string]any{"name": "node-a"}},
	}}
	nodes := []runtime.Object{}
	for i := range count {
		nodes = append(nodes, testNode(fmt.Sprintf("node-%c", 'a'+i)))
	}
	c := &Controller{Config: Config{Namespace: "test", Instance: "release", PriorityClass: "scan", CacheDir: t.TempDir()}, Kube: fake.NewClientset(nodes...), Dynamic: dynamicfake.NewSimpleDynamicClient(runtime.NewScheme(), image)}
	c.informer = cache.NewSharedIndexInformer(&cache.ListWatch{}, &unstructured.Unstructured{}, 0, cache.Indexers{})
	if err := c.informer.GetStore().Add(image); err != nil {
		t.Fatal(err)
	}
	return c, image, Key("sha256:target", c.Config.Image, c.Config.TrivyImage, c.Config.DatabaseImage)
}

// dispatchTest records the latest outcome, then starts the next attempt if
// none is in flight: one image's share of a reconcile plus a dispatch round.
func dispatchTest(t *testing.T, c *Controller, image *unstructured.Unstructured, key string) error {
	t.Helper()
	ctx := context.Background()
	if err := c.observe(ctx, image, "sha256:target", key); err != nil {
		return err
	}
	fresh, err := c.Dynamic.Resource(images).Get(ctx, image.GetName(), metav1.GetOptions{})
	if err != nil {
		return err
	}
	nodes, err := c.Kube.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return err
	}
	_, err = c.start(ctx, pendingScan{image: fresh, digest: "sha256:target", arch: "amd64", key: key}, nodes.Items, nil)
	return err
}

func readState(t *testing.T, c *Controller) scanState {
	t.Helper()
	image, err := c.Dynamic.Resource(images).Get(context.Background(), "image", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var state scanState
	if err := json.Unmarshal([]byte(image.GetAnnotations()[c.stateAnnotation("sha256:target")]), &state); err != nil {
		t.Fatal(err)
	}
	return state
}

func currentPod(t *testing.T, c *Controller) *corev1.Pod {
	t.Helper()
	state := readState(t, c)
	pod, err := c.Kube.CoreV1().Pods("test").Get(context.Background(), state.Attempts[len(state.Attempts)-1].Pod, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return pod
}

func TestDispatchValidatesNodeImageInventory(t *testing.T) {
	c, image, key := testController(t, 2)
	stale, _ := c.Kube.CoreV1().Nodes().Get(context.Background(), "node-a", metav1.GetOptions{})
	stale.Status.Images = nil
	if _, err := c.Kube.CoreV1().Nodes().UpdateStatus(context.Background(), stale, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := dispatchTest(t, c, image, key); err != nil {
		t.Fatal(err)
	}
	pod := currentPod(t, c)
	if pod.Spec.NodeSelector["kubernetes.io/hostname"] != "node-b" {
		t.Fatal("preferred ContainerImage.nodes over a Node reporting the image in status.images")
	}
	if pod.Spec.NodeName != "" || pod.Spec.RestartPolicy != corev1.RestartPolicyNever {
		t.Fatal("must use scheduler and disable native retries")
	}
	jobs, _ := c.Kube.BatchV1().Jobs("test").List(context.Background(), metav1.ListOptions{})
	if len(jobs.Items) != 0 {
		t.Fatal("scan dispatch created a Job")
	}
}

// The kubelet reports at most 50 images in Node.status.images by default, so
// most images are only known from ContainerImage.nodes.
func TestDispatchFallsBackToContainerImageNodes(t *testing.T) {
	c, _, key := testController(t, 4)
	for _, name := range []string{"node-a", "node-b", "node-c", "node-d"} {
		node, _ := c.Kube.CoreV1().Nodes().Get(context.Background(), name, metav1.GetOptions{})
		node.Status.Images = nil
		if _, err := c.Kube.CoreV1().Nodes().UpdateStatus(context.Background(), node, metav1.UpdateOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	image, _ := c.Dynamic.Resource(images).Get(context.Background(), "image", metav1.GetOptions{})
	if err := unstructured.SetNestedSlice(image.Object, []any{
		map[string]any{"name": "node-b", "unused": true},
		map[string]any{"name": "node-c"},
		map[string]any{"name": "gone"},
	}, "nodes"); err != nil {
		t.Fatal(err)
	}
	image, err := c.Dynamic.Resource(images).Update(context.Background(), image, metav1.UpdateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"node-c", "node-b"} {
		if err := dispatchTest(t, c, image, key); err != nil {
			t.Fatal(err)
		}
		pod := currentPod(t, c)
		if got := pod.Spec.NodeSelector["kubernetes.io/hostname"]; got != want {
			t.Fatalf("attempt on %s, want %s (in-use inventory before unused)", got, want)
		}
		if readState(t, c).Attempts[len(readState(t, c).Attempts)-1].Reference != testRef {
			t.Fatal("inventory attempt must use the cached reference")
		}
		pod.Status.Phase = corev1.PodFailed
		if _, err := c.Kube.CoreV1().Pods("test").UpdateStatus(context.Background(), pod, metav1.UpdateOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	// node-a and node-d neither report nor pulled the image.
	if err := dispatchTest(t, c, image, key); err != nil || len(readState(t, c).Attempts) != 2 {
		t.Fatalf("dispatched beyond the inventory: %v", err)
	}
}

func TestFiveAttemptsSurviveRestartAndPodCleanup(t *testing.T) {
	c, image, key := testController(t, 6)
	seen := map[string]bool{}
	for attempt := 1; attempt <= 5; attempt++ {
		if err := dispatchTest(t, c, image, key); err != nil {
			t.Fatal(err)
		}
		pod := currentPod(t, c)
		node := pod.Spec.NodeSelector["kubernetes.io/hostname"]
		if seen[node] {
			t.Fatal("retried a failed Node", node)
		}
		seen[node] = true
		state := readState(t, c)
		if len(state.Attempts) != attempt {
			t.Fatalf("attempt count %d, want %d", len(state.Attempts), attempt)
		}
		pod.Status.Phase, pod.Status.Reason = corev1.PodFailed, "OOMKilled"
		if _, err := c.Kube.CoreV1().Pods("test").UpdateStatus(context.Background(), pod, metav1.UpdateOptions{}); err != nil {
			t.Fatal(err)
		}
		// A fresh process has no in-memory retry accounting.
		c = &Controller{Config: c.Config, Kube: c.Kube, Dynamic: c.Dynamic}
	}
	if err := dispatchTest(t, c, image, key); err != nil {
		t.Fatal(err)
	}
	pods, _ := c.Kube.CoreV1().Pods("test").List(context.Background(), metav1.ListOptions{})
	if len(pods.Items) != 5 {
		t.Fatal("expected exactly five attempt Pods")
	}
	for _, pod := range pods.Items {
		if err := c.Kube.CoreV1().Pods("test").Delete(context.Background(), pod.Name, metav1.DeleteOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	for range 3 {
		c = &Controller{Config: c.Config, Kube: c.Kube, Dynamic: c.Dynamic}
		if err := dispatchTest(t, c, image, key); err != nil {
			t.Fatal(err)
		}
	}
	pods, _ = c.Kube.CoreV1().Pods("test").List(context.Background(), metav1.ListOptions{})
	if len(pods.Items) != 0 || len(readState(t, c).Attempts) != 5 {
		t.Fatal("cleanup reset attempt budget")
	}
}

func TestCacheMissEndsAttemptAndMovesToAnotherNode(t *testing.T) {
	c, image, key := testController(t, 2)
	if err := dispatchTest(t, c, image, key); err != nil {
		t.Fatal(err)
	}
	first := currentPod(t, c)
	first.Status.InitContainerStatuses = []corev1.ContainerStatus{{State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "ErrImageNeverPull"}}}}
	if _, err := c.Kube.CoreV1().Pods("test").UpdateStatus(context.Background(), first, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := dispatchTest(t, c, image, key); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Kube.CoreV1().Pods("test").Get(context.Background(), first.Name, metav1.GetOptions{}); !apierrors.IsNotFound(err) {
		t.Fatal("cache miss kept consuming quota")
	}
	if err := dispatchTest(t, c, image, key); err != nil {
		t.Fatal(err)
	}
	second := currentPod(t, c)
	if second.Spec.NodeSelector["kubernetes.io/hostname"] == first.Spec.NodeSelector["kubernetes.io/hostname"] {
		t.Fatal("cache miss retried on same Node")
	}
	if state := readState(t, c); len(state.Attempts) != 2 || state.Attempts[0].Reason != "ErrImageNeverPull" {
		t.Fatalf("lost cache-miss outcome: %+v", state)
	}
}

// A Pod created before its attempt was recorded is adopted on the next round,
// not duplicated, and the attempt budget is not consumed twice.
func TestLostRecordAdoptsExistingPod(t *testing.T) {
	c, image, key := testController(t, 2)
	if err := dispatchTest(t, c, image, key); err != nil {
		t.Fatal(err)
	}
	pod := currentPod(t, c)
	pod.UID = "existing-scan-uid"
	if _, err := c.Kube.CoreV1().Pods(pod.Namespace).Update(context.Background(), pod, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	// Real client-go returns an empty, non-nil Pod with AlreadyExists.
	c.Kube.(*fake.Clientset).PrependReactor("create", "pods", func(ktesting.Action) (bool, runtime.Object, error) {
		return true, &corev1.Pod{}, apierrors.NewAlreadyExists(corev1.Resource("pods"), pod.Name)
	})
	fresh, _ := c.Dynamic.Resource(images).Get(context.Background(), "image", metav1.GetOptions{})
	annotations := fresh.GetAnnotations()
	delete(annotations, c.stateAnnotation("sha256:target"))
	fresh.SetAnnotations(annotations)
	if _, err := c.Dynamic.Resource(images).Update(context.Background(), fresh, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := dispatchTest(t, c, image, key); err != nil {
		t.Fatal(err)
	}
	state := readState(t, c)
	if len(state.Attempts) != 1 || state.Attempts[0].Pod != pod.Name || state.Attempts[0].UID != pod.UID || state.Attempts[0].Hostname != pod.Spec.NodeSelector["kubernetes.io/hostname"] || state.Attempts[0].Reference != testRef {
		t.Fatalf("existing Pod not adopted: %+v", state)
	}
	pods, _ := c.Kube.CoreV1().Pods("test").List(context.Background(), metav1.ListOptions{})
	if len(pods.Items) != 1 {
		t.Fatalf("%d scan Pods, want 1", len(pods.Items))
	}
}

func TestFillRespectsParallelism(t *testing.T) {
	c, _, _ := testController(t, 2)
	c.Log = slog.New(slog.DiscardHandler)
	c.podStore = cache.NewStore(cache.MetaNamespaceKeyFunc)
	for _, name := range []string{"busy-1", "busy-2"} {
		if err := c.podStore.Add(&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "test"}, Status: corev1.PodStatus{Phase: corev1.PodRunning}}); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.podStore.Add(&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "done", Namespace: "test"}, Status: corev1.PodStatus{Phase: corev1.PodSucceeded}}); err != nil {
		t.Fatal(err)
	}
	c.Config.Parallelism = 2
	c.fill(context.Background())
	if pods, _ := c.Kube.CoreV1().Pods("test").List(context.Background(), metav1.ListOptions{}); len(pods.Items) != 0 {
		t.Fatal("started a scan with every slot in use")
	}
	c.Config.Parallelism = 3
	c.fill(context.Background())
	if pods, _ := c.Kube.CoreV1().Pods("test").List(context.Background(), metav1.ListOptions{}); len(pods.Items) != 1 {
		t.Fatalf("%d scans started for one free slot", len(pods.Items))
	}
}

func TestOrderPutsRepeatedFailuresLast(t *testing.T) {
	seenFirst := map[string]bool{}
	for range 200 {
		pending := []pendingScan{{key: "failing", attempts: 3}, {key: "a"}, {key: "once", attempts: 1}, {key: "b"}, {key: "c"}}
		order(pending)
		if pending[3].key != "once" || pending[4].key != "failing" {
			t.Fatalf("order = %+v", pending)
		}
		seenFirst[pending[0].key] = true
	}
	if len(seenFirst) != 3 {
		t.Fatalf("fresh scans are not picked at random: %v", seenFirst)
	}
}

func TestSuccessfulArtifactRegeneratesAfterEviction(t *testing.T) {
	c, image, key := testController(t, 1)
	if err := dispatchTest(t, c, image, key); err != nil {
		t.Fatal(err)
	}
	pod := currentPod(t, c)
	if err := os.WriteFile(filepath.Join(c.Config.CacheDir, key+artifactSuffix), gzipTestBytes(t, []byte(`{"bomFormat":"CycloneDX"}`)), 0600); err != nil {
		t.Fatal(err)
	}
	if err := c.reconcile(context.Background(), image.GetName()); err != nil {
		t.Fatal(err)
	}
	if readState(t, c).Attempts[0].Outcome != "succeeded" {
		t.Fatal("success was not persisted before Pod cleanup")
	}
	if err := os.Remove(filepath.Join(c.Config.CacheDir, key+artifactSuffix)); err != nil {
		t.Fatal(err)
	}
	// A retained successful Pod must not collide with the next scan cycle.
	if err := dispatchTest(t, c, image, key); err != nil {
		t.Fatal(err)
	}
	if next := currentPod(t, c); next.Name == pod.Name {
		t.Fatal("artifact regeneration reused old Pod name")
	}
	if state := readState(t, c); state.Generation != 1 || len(state.Attempts) != 1 {
		t.Fatal("regeneration did not start a fresh cycle")
	}
}

func TestNewArtifactVersionGetsFreshAttemptBudget(t *testing.T) {
	c, image, key := testController(t, 1)
	if err := dispatchTest(t, c, image, key); err != nil {
		t.Fatal(err)
	}
	old := currentPod(t, c)
	c.Config.TrivyImage = "trivy:v2"
	nextKey := Key("sha256:target", c.Config.Image, c.Config.TrivyImage, c.Config.DatabaseImage)
	if err := dispatchTest(t, c, image, nextKey); err != nil {
		t.Fatal(err)
	}
	if pod := currentPod(t, c); pod.Name == old.Name || pod.Annotations["driftmower.io/artifact-key"] != nextKey {
		t.Fatal("new scanner version did not start a new scan")
	}
}
func TestCachedReferencePreservesPulledIndex(t *testing.T) {
	manifests := []any{map[string]any{"architecture": "amd64", "digest": "sha256:platform"}, map[string]any{"architecture": "arm64", "digest": "sha256:arm"}}
	ref, err := cachedReference([]string{"registry/app@sha256:index"}, manifests, "amd64", "sha256:platform")
	if err != nil || ref != "registry/app@sha256:index" {
		t.Fatalf("invented uncached reference: %s %v", ref, err)
	}
	ref, err = cachedReference([]string{"registry/app@sha256:index", "registry/app@sha256:platform"}, manifests, "amd64", "sha256:platform")
	if err != nil || ref != "registry/app@sha256:platform" {
		t.Fatalf("must prefer actual manifest reference: %s %v", ref, err)
	}
	manifests = append(manifests, map[string]any{"architecture": "amd64", "digest": "sha256:variant"})
	if _, err = cachedReference([]string{"registry/app@sha256:index"}, manifests, "amd64", "sha256:platform"); err == nil {
		t.Fatal("must not attribute ambiguous platform to a manifest")
	}
}

func TestImageCacheFailureEventsEndAttemptAndMoveToAnotherNode(t *testing.T) {
	for _, tc := range []struct {
		name, reason, message string
		otherPod              bool
		retry                 bool
	}{
		{"missing image volume", "Failed", `Error: failed to mount image volume: ImageVolumeMountFailed: failed to get image volume ref "sha256:target": image "sha256:target": not found`, false, true},
		{"never pull event", "ErrImageNeverPull", `Container image "registry/app" is not present with pull policy of Never`, false, true},
		{"transient mount failure", "Failed", `failed to mount image volume: ImageVolumeMountFailed: context deadline exceeded`, false, false},
		{"old Pod event", "ErrImageNeverPull", "image is not present", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, image, key := testController(t, 2)
			if err := dispatchTest(t, c, image, key); err != nil {
				t.Fatal(err)
			}
			pod := currentPod(t, c)
			pod.UID = "current-pod"
			pod.Status.Phase = corev1.PodPending
			pod.Status.InitContainerStatuses = []corev1.ContainerStatus{{Name: "trivy", State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "PodInitializing"}}}}
			if _, err := c.Kube.CoreV1().Pods("test").Update(context.Background(), pod, metav1.UpdateOptions{}); err != nil {
				t.Fatal(err)
			}
			ref := corev1.ObjectReference{Kind: "Pod", Namespace: "test", Name: pod.Name, UID: pod.UID}
			if tc.otherPod {
				ref.UID = "old-pod"
			}
			event := &corev1.Event{ObjectMeta: metav1.ObjectMeta{Name: "mount-failure", Namespace: "test"}, Type: corev1.EventTypeWarning, Reason: tc.reason, Message: tc.message, InvolvedObject: ref}
			if _, err := c.Kube.CoreV1().Events("test").Create(context.Background(), event, metav1.CreateOptions{}); err != nil {
				t.Fatal(err)
			}
			if err := dispatchTest(t, c, image, key); err != nil {
				t.Fatal(err)
			}
			state := readState(t, c)
			_, err := c.Kube.CoreV1().Pods("test").Get(context.Background(), pod.Name, metav1.GetOptions{})
			if !tc.retry {
				if err != nil || len(state.Attempts) != 1 || state.Attempts[0].Outcome != "" {
					t.Fatalf("unrelated event ended attempt: %+v err=%v", state, err)
				}
				return
			}
			if !apierrors.IsNotFound(err) {
				t.Fatalf("cache miss kept its scan slot: %v", err)
			}
			if len(state.Attempts) != 2 || !strings.Contains(state.Attempts[0].Reason, tc.message) {
				t.Fatalf("lost cache-miss evidence: %+v", state)
			}
			if state.Attempts[0].Node == state.Attempts[1].Node {
				t.Fatalf("retried same Node: %+v", state)
			}
		})
	}
}
