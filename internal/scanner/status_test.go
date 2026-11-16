package scanner

import (
	"encoding/json"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/tools/cache"
)

func TestScanLifecycleUsesCurrentConfigurationAndRetryBudget(t *testing.T) {
	c, image, key := testController(t, 1)
	set := func(attempts []scanAttempt) {
		body, err := json.Marshal(scanState{Key: key, Attempts: attempts})
		if err != nil {
			t.Fatal(err)
		}
		image.SetAnnotations(map[string]string{c.stateAnnotation("sha256:target"): string(body)})
	}
	if got := c.scanLifecycle(image, "sha256:target", key, false); got != "pending" {
		t.Fatal(got)
	}
	set([]scanAttempt{{Outcome: "failed", Reason: "network"}})
	if got := c.scanLifecycle(image, "sha256:target", key, false); got != "pending" {
		t.Fatal("retryable failure should be pending", got)
	}
	attempts := make([]scanAttempt, maxScanAttempts)
	for i := range attempts {
		attempts[i].Outcome = "failed"
	}
	set(attempts)
	if got := c.scanLifecycle(image, "sha256:target", key, false); got != "failed" {
		t.Fatal(got)
	}
	if got := c.scanLifecycle(image, "sha256:target", Key("sha256:target", "new scanner"), false); got != "pending" {
		t.Fatal("old failure leaked into new scan configuration", got)
	}
	if got := c.scanLifecycle(image, "sha256:target", key, true); got != "done" {
		t.Fatal(got)
	}
	set([]scanAttempt{{Pod: "scan-pod"}})
	c.podStore = cache.NewStore(cache.MetaNamespaceKeyFunc)
	if err := c.podStore.Add(&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: c.Config.Namespace, Name: "scan-pod"}, Status: corev1.PodStatus{Phase: corev1.PodRunning}}); err != nil {
		t.Fatal(err)
	}
	if got := c.scanLifecycle(image, "sha256:target", key, false); got != "running" {
		t.Fatal(got)
	}
}

func TestScanStateMetricIsDeduplicatedByImmutableDigest(t *testing.T) {
	c, image, _ := testController(t, 1)
	c.ready.Store(true)
	alias := image.DeepCopy()
	alias.SetName("other-index-sharing-this-platform")
	if err := c.informer.GetStore().Add(alias); err != nil {
		t.Fatal(err)
	}
	registry := prometheus.NewRegistry()
	registry.MustRegister(&securityCollector{c})
	families, err := registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, family := range families {
		if family.GetName() != "driftmower_image_scan_state" {
			continue
		}
		found = true
		if len(family.Metric) != 1 {
			t.Fatal("aliases duplicated the scan state", family)
		}
		labels := family.Metric[0].Label
		if len(labels) != 6 {
			t.Fatal("per-digest state has extra labels", labels)
		}
		for _, label := range labels {
			if label.GetName() != "digest" && label.GetName() != "state" && label.GetName() != "trivy_version" && label.GetName() != "db_version" && label.GetName() != "coverage" && label.GetName() != "reason" {
				t.Fatal("unexpected identity label", label)
			}
		}
	}
	if !found {
		t.Fatal("scan state missing")
	}
}
