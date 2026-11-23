package scanner

import (
	"encoding/json"
	"slices"
	"strings"

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
			if pod, exists, _ := c.podStore.GetByKey(c.attemptNamespace(state.Attempts[len(state.Attempts)-1]) + "/" + state.Attempts[len(state.Attempts)-1].Pod); exists && pod.(*corev1.Pod).Status.Phase == corev1.PodRunning {
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

// Progress is the scan history of one platform manifest that has no artifact
// yet, as recorded on its ContainerImage.
type Progress struct {
	Attempts  int    `json:"attempts"`
	InFlight  bool   `json:"inFlight,omitempty"`
	Exhausted bool   `json:"exhausted,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

// ScanProgress reads the persisted attempts of digest, written by any scanner
// instance. The latest failure reason is kept while a retry runs.
func ScanProgress(image *unstructured.Unstructured, digest string) (Progress, bool) {
	for name, raw := range image.GetAnnotations() {
		if !strings.HasPrefix(name, "driftmower.io/scan-") {
			continue
		}
		var state scanState
		if json.Unmarshal([]byte(raw), &state) != nil || state.Digest != digest || len(state.Attempts) == 0 {
			continue
		}
		p := Progress{Attempts: len(state.Attempts), InFlight: state.inFlight()}
		p.Exhausted = !p.InFlight && p.Attempts >= maxScanAttempts && state.Attempts[p.Attempts-1].Outcome == "failed"
		for _, a := range slices.Backward(state.Attempts) {
			if a.Outcome == "failed" && a.Reason != "" {
				p.Reason = a.Reason
				break
			}
		}
		return p, true
	}
	return Progress{}, false
}
