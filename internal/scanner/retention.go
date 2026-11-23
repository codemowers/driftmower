package scanner

import (
	"context"
	"encoding/json"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const succeededPodRetention = 2 * time.Minute
const failedPodRetention = 48 * time.Hour

func (c *Controller) updateRetention(ctx context.Context) error {
	pods, err := c.Kube.CoreV1().Pods(c.scanNamespace()).List(ctx, metav1.ListOptions{LabelSelector: "app=" + c.Config.scanServiceAccount()})
	if err != nil {
		return err
	}
	for _, pod := range pods.Items {
		if pod.DeletionTimestamp != nil {
			continue
		}
		retention := failedPodRetention
		digest := pod.Annotations["driftmower.io/platform-digest"]
		superseded := digest != "" && pod.Annotations["driftmower.io/artifact-key"] != c.Config.artifactKey(digest)
		obsoleteExpired := false
		if pod.Status.Phase != corev1.PodSucceeded && pod.Status.Phase != corev1.PodFailed &&
			superseded {
			reason, err := c.scanPodFailure(ctx, &pod)
			if err != nil {
				return err
			}
			obsoleteExpired = reason != ""
		}
		if pod.Status.Phase == corev1.PodSucceeded {
			retention = succeededPodRetention
		} else if obsoleteExpired {
			retention = 0
		} else if pod.Status.Phase != corev1.PodFailed {
			continue
		}
		finishedAt := pod.CreationTimestamp.Time
		for _, status := range append(pod.Status.InitContainerStatuses, pod.Status.ContainerStatuses...) {
			if term := status.State.Terminated; term != nil && term.FinishedAt.After(finishedAt) {
				finishedAt = term.FinishedAt.Time
			}
		}
		if finishedAt.IsZero() || time.Since(finishedAt) < retention {
			continue
		}
		imageName := pod.Annotations["driftmower.io/container-image"]
		if imageName == "" {
			continue
		}
		image, err := c.Dynamic.Resource(images).Get(ctx, imageName, metav1.GetOptions{})
		if apierrors.IsNotFound(err) {
			continue
		}
		if err != nil {
			return err
		}
		if !ownsScanPod(&pod, image, pod.Annotations["driftmower.io/artifact-key"], c.Config.scanServiceAccount()) {
			continue
		}
		// Obsolete timed-out attempts cannot satisfy the current configuration;
		// release their slots even if their state has already been superseded.
		// Current attempts retain their evidence until the outcome is durable.
		// A newer configuration has replaced the old attempt annotation, so
		// its terminal Pods cannot retain a matching durable record forever.
		recorded := obsoleteExpired || superseded
		for _, raw := range image.GetAnnotations() {
			var state scanState
			if json.Unmarshal([]byte(raw), &state) != nil {
				continue
			}
			for _, attempt := range state.Attempts {
				if attempt.Pod == pod.Name && c.attemptNamespace(attempt) == pod.Namespace && attempt.Outcome != "" {
					recorded = true
				}
			}
		}
		if !recorded {
			continue
		}
		if err := c.Kube.CoreV1().Pods(pod.Namespace).Delete(ctx, pod.Name, metav1.DeleteOptions{Preconditions: &metav1.Preconditions{UID: &pod.UID}}); err != nil && !apierrors.IsNotFound(err) {
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
		// Pending image-volume failures and scheduling stalls may produce no
		// further updates. Recheck deadlines without depending on Pod events.
		objects := c.informer.GetStore().List()
		for _, obj := range objects {
			c.queue.Add(obj.(interface{ GetName() string }).GetName())
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
