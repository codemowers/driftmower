package scanner

import (
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func (c *Controller) scanLifecycle(image *unstructured.Unstructured, digest, key string, available bool) string {
	if available {
		return "done"
	}
	state, err := c.loadState(image, digest, key)
	if err != nil {
		return "unavailable"
	}
	if state.inFlight() {
		if c.podStore != nil {
			if pod, exists, _ := c.podStore.GetByKey(c.Config.Namespace + "/" + state.Attempts[len(state.Attempts)-1].Pod); exists && pod.(*corev1.Pod).Status.Phase == corev1.PodRunning {
				return "running"
			}
		}
		return "pending"
	}
	if len(state.Attempts) >= maxScanAttempts && state.Attempts[len(state.Attempts)-1].Outcome == "failed" {
		return "failed"
	}
	return "pending"
}
