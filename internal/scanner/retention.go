package scanner

import (
	"context"
	"fmt"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

const succeededJobTTL int32 = 120
const failedJobTTL int32 = 48 * 60 * 60

func jobRetention(job *batchv1.Job) int32 {
	for _, condition := range job.Status.Conditions {
		if condition.Type == batchv1.JobComplete && condition.Status == corev1.ConditionTrue {
			return succeededJobTTL
		}
	}
	// The safe initial default also protects failures while the operator is down.
	return failedJobTTL
}

func (c *Controller) updateRetention(ctx context.Context) error {
	jobs, err := c.Kube.BatchV1().Jobs(c.Config.Namespace).List(ctx, metav1.ListOptions{LabelSelector: "app=driftmower-scan"})
	if err != nil {
		return err
	}
	for _, job := range jobs.Items {
		ttl := jobRetention(&job)
		if job.DeletionTimestamp != nil || job.Spec.TTLSecondsAfterFinished != nil && *job.Spec.TTLSecondsAfterFinished == ttl {
			continue
		}
		patch := []byte(fmt.Sprintf(`{"metadata":{"resourceVersion":%q},"spec":{"ttlSecondsAfterFinished":%d}}`, job.ResourceVersion, ttl))
		if _, err := c.Kube.BatchV1().Jobs(c.Config.Namespace).Patch(ctx, job.Name, types.MergePatchType, patch, metav1.PatchOptions{}); err != nil {
			return err
		}
	}
	return nil
}

func (c *Controller) reconcileRetention(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		if err := c.updateRetention(ctx); err != nil && ctx.Err() == nil {
			c.Log.Warn("scan retention deferred", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
