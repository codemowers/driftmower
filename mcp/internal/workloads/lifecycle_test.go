package workloads

import (
	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"testing"
)

func TestLifecycleProjection(t *testing.T) {
	zero := int32(0)
	deployment, err := Project(sourceFor(t, "Deployment"), &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "sleeping", Namespace: "apps", UID: "deployment"}, Spec: appsv1.DeploymentSpec{Replicas: &zero}})
	if err != nil || deployment.DesiredReplicas == nil || *deployment.DesiredReplicas != 0 {
		t.Fatalf("lost desired replicas: %+v %v", deployment, err)
	}
	inv := BuildInventory("apps", []SourceItems{{Source: sourceFor(t, "Deployment"), Items: []*Node{deployment}}}, map[string]bool{})
	if len(inv) != 1 || inv[0].DesiredReplicas == nil || *inv[0].DesiredReplicas != 0 {
		t.Fatalf("lost root lifecycle: %+v", inv)
	}
	job, err := Project(sourceFor(t, "Job"), &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: "done", Namespace: "apps", UID: "job"}, Status: batchv1.JobStatus{Conditions: []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}}})
	if err != nil || !job.Completed {
		t.Fatalf("completion not retained: %+v %v", job, err)
	}
	inv = BuildInventory("apps", []SourceItems{{Source: sourceFor(t, "Job"), Items: []*Node{job}}}, map[string]bool{})
	if len(inv) != 1 || !inv[0].Completed {
		t.Fatalf("completion lost after pods are gone: %+v", inv)
	}
	active, err := Project(sourceFor(t, "Job"), &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: "new", Namespace: "apps", UID: "new-job"}})
	if err != nil || active.Completed {
		t.Fatal("a job without pods is not necessarily finished")
	}
}
