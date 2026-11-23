package scanner

import (
	"bytes"
	"context"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/tools/cache"
)

func TestFailedPodLimitStopsAllNewDispatchAndSurvivesRestart(t *testing.T) {
	c, _, _ := testController(t, 2)
	c.Config.MaxFailedPods = 2
	var logs bytes.Buffer
	c.Log = slog.New(slog.NewTextHandler(&logs, nil))
	c.podStore = cache.NewStore(cache.MetaNamespaceKeyFunc)
	failures := []*corev1.Pod{}
	for _, name := range []string{"old-version-failure", "another-image-failure"} {
		pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "test", Labels: map[string]string{"app": c.Config.scanServiceAccount()}}, Spec: corev1.PodSpec{ServiceAccountName: c.Config.scanServiceAccount()}, Status: corev1.PodStatus{Phase: corev1.PodFailed}}
		if err := c.podStore.Add(pod); err != nil {
			t.Fatal(err)
		}
		failures = append(failures, pod)
	}
	for range 3 {
		c.fill(context.Background())
	}
	pods, err := c.Kube.CoreV1().Pods("test").List(context.Background(), metav1.ListOptions{})
	if err != nil || len(pods.Items) != 0 {
		t.Fatalf("dispatcher created Pods despite failure limit: %d %v", len(pods.Items), err)
	}
	if strings.Count(logs.String(), "scan dispatch stopped") != 1 {
		t.Fatalf("stop log repeated: %s", logs.String())
	}
	restarted := &Controller{Config: c.Config, Kube: c.Kube, Dynamic: c.Dynamic, Log: c.Log, informer: c.informer, podStore: c.podStore}
	restarted.fill(context.Background())
	if !restarted.dispatchHalted.Load() {
		t.Fatal("restart reset global failure limit")
	}
	response := httptest.NewRecorder()
	c.Handler().ServeHTTP(response, httptest.NewRequest("GET", "/metrics", nil))
	for _, metric := range []string{"driftmower_scanner_failed_pods 2", "driftmower_scanner_failed_pod_limit 2"} {
		if !strings.Contains(response.Body.String(), metric) {
			t.Fatalf("missing %s", metric)
		}
	}
	// Diagnostic failures must be reviewed/removed before dispatch resumes.
	if err := c.podStore.Delete(failures[0]); err != nil {
		t.Fatal(err)
	}
	c.fill(context.Background())
	pods, err = c.Kube.CoreV1().Pods("test").List(context.Background(), metav1.ListOptions{})
	if err != nil || len(pods.Items) != 1 || c.dispatchHalted.Load() {
		t.Fatalf("dispatch did not resume below limit: pods=%d error=%v", len(pods.Items), err)
	}
	if pods.Items[0].Spec.HostUsers == nil || *pods.Items[0].Spec.HostUsers || pods.Items[0].Labels["driftmower-scan"] != "driftmower-scan" {
		t.Fatal("new scan lacks user namespace or policy label")
	}
}

func TestFailedPodLimitIgnoresOtherServiceAccounts(t *testing.T) {
	c, _, _ := testController(t, 1)
	c.Config.MaxFailedPods = 1
	c.podStore = cache.NewStore(cache.MetaNamespaceKeyFunc)
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "other", Namespace: "test", Labels: map[string]string{"app": c.Config.scanServiceAccount()}}, Spec: corev1.PodSpec{ServiceAccountName: "other"}, Status: corev1.PodStatus{Phase: corev1.PodFailed}}
	if err := c.podStore.Add(pod); err != nil {
		t.Fatal(err)
	}
	if c.failedScanPods() != 0 || c.failedPodLimit() != 1 {
		t.Fatal("unrelated failure counted or configured limit ignored")
	}
	c.Config.MaxFailedPods = 0
	if c.failedPodLimit() != DefaultMaxFailedPods {
		t.Fatal("default failure limit missing")
	}
}
