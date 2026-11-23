package scanner

import (
	"github.com/prometheus/client_golang/prometheus"
	corev1 "k8s.io/api/core/v1"
)

const DefaultMaxFailedPods = 20

func (c *Controller) failedPodLimit() int {
	if c.Config.MaxFailedPods > 0 {
		return c.Config.MaxFailedPods
	}
	return DefaultMaxFailedPods
}

// Count retained failures across images and scanner versions. A shared runtime
// failure must not consume five attempts for every image in the inventory.
// The Pod informer rebuilds this count after restarts; no separate history is
// kept, and deleting reviewed failures allows dispatch to resume.
func (c *Controller) failedScanPods() int {
	if c.podStore == nil {
		return 0
	}
	failed := 0
	for _, obj := range c.podStore.List() {
		pod, ok := obj.(*corev1.Pod)
		if ok && pod.Status.Phase == corev1.PodFailed && pod.Labels["app"] == c.Config.scanServiceAccount() && pod.Spec.ServiceAccountName == c.Config.scanServiceAccount() {
			failed++
		}
	}
	return failed
}

// Stop only new dispatch. Keep the operator serving retained artifacts,
// recording in-flight outcomes and cleaning up diagnostic Pods.
func (c *Controller) dispatchAllowed() bool {
	failed, limit := c.failedScanPods(), c.failedPodLimit()
	if failed >= limit {
		if c.dispatchHalted.CompareAndSwap(false, true) {
			c.Log.Error("scan dispatch stopped: failed Pod limit reached", "failedPods", failed, "limit", limit, "nextSteps", "inspect failed scan Pods and fix the cause; remove reviewed failed Pods to resume dispatch")
		}
		return false
	}
	if c.dispatchHalted.Swap(false) {
		c.Log.Info("scan dispatch resumed", "failedPods", failed, "limit", limit)
	}
	return true
}

var scanDispatchMetrics = map[string]*prometheus.Desc{
	"failed": prometheus.NewDesc("driftmower_scanner_failed_pods", "Retained failed scan Pods for this release, including older scanner versions; refreshed from the Pod informer.", nil, nil),
	"limit":  prometheus.NewDesc("driftmower_scanner_failed_pod_limit", "Failed scan Pod count at which new dispatch stops. Existing scans and artifact reads continue.", nil, nil),
}

type scanDispatchCollector struct{ controller *Controller }

func (*scanDispatchCollector) Describe(ch chan<- *prometheus.Desc) {
	for _, desc := range scanDispatchMetrics {
		ch <- desc
	}
}

func (s *scanDispatchCollector) Collect(ch chan<- prometheus.Metric) {
	if s.controller.podStore == nil {
		return
	}
	ch <- prometheus.MustNewConstMetric(scanDispatchMetrics["failed"], prometheus.GaugeValue, float64(s.controller.failedScanPods()))
	ch <- prometheus.MustNewConstMetric(scanDispatchMetrics["limit"], prometheus.GaugeValue, float64(s.controller.failedPodLimit()))
}
