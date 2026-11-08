package scanner

import (
	"context"
	"k8s.io/client-go/tools/cache"
	"sync"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/kubernetes/fake"
)

func testNode(name string) *corev1.Node {
	return &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: name, Labels: map[string]string{"kubernetes.io/hostname": name, "kubernetes.io/arch": "amd64"}}, Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionTrue}}}}
}
func TestDispatchCreatesJobsWithoutOperatorAdmissionLimit(t *testing.T) {
	ctx := context.Background()
	c := &Controller{Config: Config{Namespace: "test", PriorityClass: "driftmower-scan"}, Kube: fake.NewClientset(testNode("node-a"), testNode("node-b"))}
	var wg sync.WaitGroup
	for _, name := range []string{"a", "b"} {
		wg.Go(func() {
			image := &unstructured.Unstructured{}
			image.SetName(name)
			image.SetUID("image-uid")
			_ = c.dispatch(ctx, image, []any{map[string]any{"name": "node-" + name}}, "amd64", "digest", "image@sha256:target", Key(name, "scanner"))
		})
	}
	wg.Wait()
	jobs, err := c.Kube.BatchV1().Jobs("test").List(ctx, metav1.ListOptions{})
	if err != nil || len(jobs.Items) != 2 {
		t.Fatalf("quota must admit Pods, not prevent Job creation: %v, %d", err, len(jobs.Items))
	}
	// Existing Jobs must not prevent creating another desired Job.
	restarted := &Controller{Config: c.Config, Kube: c.Kube}
	image := &unstructured.Unstructured{}
	image.SetName("new")
	if err := restarted.dispatch(ctx, image, []any{map[string]any{"name": "node-a"}, map[string]any{"name": "node-b"}}, "amd64", "digest", "image@sha256:target", Key("new", "scanner")); err != nil {
		t.Fatal("Job creation must not be gated by an operator budget", err)
	}
}
func TestDispatchAdoptsExistingJob(t *testing.T) {
	ctx := context.Background()
	key := Key("digest", "scanner")
	job := ScanJobForNodes(Config{Namespace: "test", PriorityClass: "driftmower-scan"}, key, "image", "uid", "image@sha256:target", "amd64", JobName("image", "digest"), []string{"node-a"})
	job.Annotations["driftmower.io/pod-spec-hash"] = podSpecHash(job)
	job.Annotations["driftmower.io/image-reference"] = "image@sha256:target"
	c := &Controller{Config: Config{Namespace: "test", PriorityClass: "driftmower-scan"}, Kube: fake.NewClientset(job, testNode("node-a"))}
	image := &unstructured.Unstructured{}
	image.SetName("image")
	if err := c.dispatch(ctx, image, []any{map[string]any{"name": "node-a"}}, "amd64", "digest", "image@sha256:target", key); err != nil {
		t.Fatalf("must adopt active Job even when no slot is free: %v", err)
	}
}
func TestFailedPodIsNotFinishedJob(t *testing.T) {
	job := &batchv1.Job{Status: batchv1.JobStatus{Failed: 1}}
	if finished(job) {
		t.Fatal("failed pod counter alone does not establish terminated Job")
	}
	job.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobFailed, Status: corev1.ConditionTrue}}
	if !finished(job) {
		t.Fatal("terminal condition must release slot")
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

func TestMissingCachedImageReleasesSlotAndTriesAnotherNode(t *testing.T) {
	ctx := context.Background()
	config := Config{Namespace: "test", PriorityClass: "driftmower-scan"}
	key := Key("digest", "scanner")
	job := ScanJob(config, key, "image", "image-uid", "registry/app@sha256:index", "node-a", JobName("image", "digest"))
	job.UID = "job-uid"
	job.Annotations["driftmower.io/image-reference"] = "registry/app@sha256:index"
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "scan-pod", Namespace: "test", Labels: map[string]string{"batch.kubernetes.io/job-name": job.Name}, OwnerReferences: []metav1.OwnerReference{{Kind: "Job", UID: job.UID}}}, Status: corev1.PodStatus{InitContainerStatuses: []corev1.ContainerStatus{{Name: "trivy", State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "ErrImageNeverPull"}}}}}}
	c := &Controller{Config: config, Kube: fake.NewClientset(job, pod, testNode("node-a"), testNode("node-b"))}
	if err := c.releaseMissingImage(ctx, job, key); err == nil {
		t.Fatal("cache miss must be retried")
	}
	jobs, _ := c.Kube.BatchV1().Jobs("test").List(ctx, metav1.ListOptions{})
	if len(jobs.Items) != 1 || *jobs.Items[0].Spec.ActiveDeadlineSeconds != 1 || *jobs.Items[0].Spec.TTLSecondsAfterFinished != failedJobTTL {
		t.Fatal("cache miss must end its attempt without discarding the Job")
	}
	// Kubernetes terminates the pending Pod and marks the Job failed.
	ended := jobs.Items[0].DeepCopy()
	ended.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobFailed, Status: corev1.ConditionTrue}}
	if _, err := c.Kube.BatchV1().Jobs("test").UpdateStatus(ctx, ended, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	image := &unstructured.Unstructured{}
	image.SetName("image")
	if err := c.dispatch(ctx, image, []any{map[string]any{"name": "node-a"}, map[string]any{"name": "node-b"}}, "amd64", "digest", "registry/app@sha256:index", key); err == nil {
		t.Fatal("must wait for changed-spec Job deletion")
	}
	if err := c.dispatch(ctx, image, []any{map[string]any{"name": "node-a"}, map[string]any{"name": "node-b"}}, "amd64", "digest", "registry/app@sha256:index", key); err != nil {
		t.Fatal(err)
	}
	jobs, _ = c.Kube.BatchV1().Jobs("test").List(ctx, metav1.ListOptions{})
	if len(jobs.Items) != 1 || jobs.Items[0].Spec.Template.Spec.Affinity.NodeAffinity.RequiredDuringSchedulingIgnoredDuringExecution.NodeSelectorTerms[0].MatchExpressions[0].Values[0] != "node-b" {
		t.Fatalf("failed node was immediately retried: %+v", jobs)
	}
}

func TestReconcileDoesNotWaitForScanCompletion(t *testing.T) {
	c := &Controller{Config: Config{Namespace: "test", PriorityClass: "driftmower-scan", CacheDir: t.TempDir()}, Kube: fake.NewClientset(testNode("node-a"))}
	c.informer = cache.NewSharedIndexInformer(&cache.ListWatch{}, &unstructured.Unstructured{}, 0, cache.Indexers{})
	for _, name := range []string{"first", "second", "third"} {
		image := &unstructured.Unstructured{Object: map[string]any{"metadata": map[string]any{"name": name, "uid": name}, "repoDigests": []any{"registry/app@sha256:" + name}, "nodes": []any{map[string]any{"name": "node-a"}}, "manifests": []any{map[string]any{"architecture": "amd64", "digest": "sha256:" + name}}}}
		if err := c.informer.GetStore().Add(image); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		err := c.reconcile(ctx, name)
		cancel()
		if err != nil {
			t.Fatal("reconcile waited for an unfinished scan", err)
		}
	}
	jobs, err := c.Kube.BatchV1().Jobs("test").List(context.Background(), metav1.ListOptions{})
	if err != nil || len(jobs.Items) != 3 {
		t.Fatalf("expected all Jobs before any scan completed: %v %+v", err, jobs)
	}
	for _, job := range jobs.Items {
		if job.Spec.ActiveDeadlineSeconds != nil || job.Spec.Template.Spec.ActiveDeadlineSeconds == nil || *job.Spec.Template.Spec.ActiveDeadlineSeconds != 900 {
			t.Fatal("quota waiting must not consume the execution deadline")
		}
		if job.Spec.Template.Spec.PriorityClassName != "driftmower-scan" {
			t.Fatal("scan missing quota-scoped priority class")
		}
	}
}
