package scanner

import (
	"context"
	"testing"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/utils/ptr"
)

func TestOutcomeRetention(t *testing.T) {
	success := ScanJob(Config{Namespace: "test"}, Key("a", "test"), "image", "uid", "ref", "node")
	failure := ScanJob(Config{Namespace: "test"}, Key("b", "test"), "image", "uid", "ref", "node")
	active := ScanJob(Config{Namespace: "test"}, Key("c", "test"), "image", "uid", "ref", "node")
	success.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}
	failure.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobFailed, Status: corev1.ConditionTrue}}
	success.Spec.TTLSecondsAfterFinished = ptr.To[int32](3600)
	failure.Spec.TTLSecondsAfterFinished = ptr.To[int32](3600)
	c := &Controller{Config: Config{Namespace: "test"}, Kube: fake.NewClientset(success, failure, active)}
	if err := c.updateRetention(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		job  *batchv1.Job
		want int32
	}{{success, 120}, {failure, 172800}, {active, 172800}} {
		got, err := c.Kube.BatchV1().Jobs("test").Get(context.Background(), tc.job.Name, metav1.GetOptions{})
		if err != nil || got.Spec.TTLSecondsAfterFinished == nil || *got.Spec.TTLSecondsAfterFinished != tc.want {
			t.Fatalf("retention for %s: %v %+v", tc.job.Name, err, got)
		}
	}
}

func TestNativeRetriesAndStableJobReplacement(t *testing.T) {
	ctx := context.Background()
	config := Config{Namespace: "test", Image: "operator:v1", PriorityClass: "driftmower-scan"}
	image := &unstructured.Unstructured{}
	image.SetName("image")
	image.SetUID("image-uid")
	key := Key("digest", config.Image, config.TrivyImage, config.DatabaseImage)
	c := &Controller{Config: config, Kube: fake.NewClientset(testNode("node-a"))}
	candidates := []any{map[string]any{"name": "node-a"}}
	if err := c.dispatch(ctx, image, candidates, "amd64", "digest", "registry/app@sha256:index", key); err != nil {
		t.Fatal(err)
	}
	name := JobName("image", "digest")
	job, err := c.Kube.BatchV1().Jobs("test").Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if *job.Spec.BackoffLimit != 6 || *job.Spec.TTLSecondsAfterFinished != failedJobTTL {
		t.Fatal("native retries and safe failure retention required")
	}
	job.Status.Failed = 1 // One Pod failed; the Job controller still owns retries.
	if _, err = c.Kube.BatchV1().Jobs("test").UpdateStatus(ctx, job, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if err = c.dispatch(ctx, image, candidates, "amd64", "digest", "registry/app@sha256:index", key); err != nil {
		t.Fatal("must adopt retrying Job", err)
	}
	job.Status.Conditions = []batchv1.JobCondition{{Type: batchv1.JobFailed, Status: corev1.ConditionTrue}}
	if _, err = c.Kube.BatchV1().Jobs("test").UpdateStatus(ctx, job, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if err = c.dispatch(ctx, image, candidates, "amd64", "digest", "registry/app@sha256:index", key); err != nil {
		t.Fatal("unchanged failed Job should be retained without reconciliation churn", err)
	}
	if _, err = c.Kube.BatchV1().Jobs("test").Get(ctx, name, metav1.GetOptions{}); err != nil {
		t.Fatal("failed Job was removed", err)
	}
	c.Config.Image = "operator:v2"
	nextKey := Key("digest", c.Config.Image, c.Config.TrivyImage, c.Config.DatabaseImage)
	if err = c.dispatch(ctx, image, candidates, "amd64", "digest", "registry/app@sha256:index", nextKey); err == nil {
		t.Fatal("changed spec must wait for replacement")
	}
	if err = c.dispatch(ctx, image, candidates, "amd64", "digest", "registry/app@sha256:index", nextKey); err != nil {
		t.Fatal(err)
	}
	replaced, err := c.Kube.BatchV1().Jobs("test").Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if replaced.Annotations["driftmower.io/artifact-key"] != nextKey || replaced.Spec.Template.Spec.Containers[0].Env[0].Value != c.Config.URL+"/internal/scans/"+name {
		t.Fatal("stable Job name and versioned artifact must remain separate")
	}
}
