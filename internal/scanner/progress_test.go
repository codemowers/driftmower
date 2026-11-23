package scanner

import (
	"context"
	"encoding/json"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestScanPodExitUsesTerminationMessage(t *testing.T) {
	pod := &corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodFailed, InitContainerStatuses: []corev1.ContainerStatus{{
		Name:  "trivy",
		State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ExitCode: 1, Reason: "Error", Message: "scan would be incomplete, unreadable paths in the image (1): /root \n"}},
	}}}}
	if got, want := scanPodExit(pod), "trivy exited with code 1: scan would be incomplete, unreadable paths in the image (1): /root"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	pod.Status.InitContainerStatuses[0].State.Terminated.Message = strings.Repeat("x", 2*maxReason) + "FATAL end"
	if got := scanPodExit(pod); !strings.HasSuffix(got, "FATAL end") || len(got) > maxReason+64 {
		t.Fatalf("long messages keep their end within the bound, got %d bytes", len(got))
	}
}

func TestScanProgressReadsLatestFailure(t *testing.T) {
	state := scanState{Key: "k", Digest: "sha256:a", Attempts: []scanAttempt{
		{Pod: "p1", Outcome: "failed", Reason: "first"},
		{Pod: "p2", Outcome: "failed", Reason: "second"},
		{Pod: "p3"},
	}}
	raw, _ := json.Marshal(state)
	image := &unstructured.Unstructured{}
	image.SetAnnotations(map[string]string{"driftmower.io/scan-abc": string(raw), "driftmower.io/sbom-x": "y"})
	p, ok := ScanProgress(image, "sha256:a")
	if !ok || p.Attempts != 3 || !p.InFlight || p.Exhausted || p.Reason != "second" {
		t.Fatalf("unexpected progress %+v %v", p, ok)
	}
	if _, ok := ScanProgress(image, "sha256:b"); ok {
		t.Fatal("other digests have no progress")
	}
	state.Attempts = append(state.Attempts[:2], scanAttempt{Outcome: "failed", Reason: "r3"}, scanAttempt{Outcome: "failed", Reason: "r4"}, scanAttempt{Outcome: "failed", Reason: "r5"})
	raw, _ = json.Marshal(state)
	image.SetAnnotations(map[string]string{"driftmower.io/scan-abc": string(raw)})
	if p, _ := ScanProgress(image, "sha256:a"); !p.Exhausted || p.Reason != "r5" {
		t.Fatalf("exhausted attempts report the last failure, got %+v", p)
	}
}

func TestTrivyRunsAsNamespacedRoot(t *testing.T) {
	pod := ScanPod(Config{ReadAllFiles: true}, strings.Repeat("a", 64), "img", "uid", "ref", "node", "amd64", "scan")
	sc := pod.Spec.InitContainers[1].SecurityContext
	if *sc.RunAsUser != 0 || *sc.RunAsNonRoot || pod.Spec.HostUsers == nil || *pod.Spec.HostUsers {
		t.Fatal("trivy must run as root inside a user namespace")
	}
	if len(sc.Capabilities.Drop) != 1 || sc.Capabilities.Drop[0] != "ALL" || len(sc.Capabilities.Add) != 1 || sc.Capabilities.Add[0] != "DAC_READ_SEARCH" {
		t.Fatalf("unexpected capabilities %+v", sc.Capabilities)
	}
	if up := pod.Spec.Containers[0].SecurityContext; up.RunAsUser != nil || len(up.Capabilities.Add) != 0 {
		t.Fatal("the upload container keeps the non-root Pod user")
	}
}

func TestSupersededProgressClearsBeforeAnotherAttemptStarts(t *testing.T) {
	c, image, key := testController(t, 1)
	ctx := context.Background()
	previous := scanState{Key: "old-scanner", Digest: "sha256:target", Attempts: []scanAttempt{{Pod: "old", Outcome: "failed", Reason: "scan attempt exceeded 15 minutes"}}}
	if err := c.saveScanState(ctx, image, "sha256:target", previous); err != nil {
		t.Fatal(err)
	}
	if err := c.observe(ctx, image, "sha256:target", key); err != nil {
		t.Fatal(err)
	}
	current, err := c.Dynamic.Resource(images).Get(ctx, image.GetName(), metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if p, ok := ScanProgress(current, "sha256:target"); ok {
		t.Fatalf("superseded failure still visible: %+v", p)
	}
	state := readState(t, c)
	if state.Key != key || state.Digest != "sha256:target" || len(state.Attempts) != 0 {
		t.Fatalf("incorrect reset: %+v", state)
	}
	// A second observation must not create a resource update loop.
	before := len(c.Dynamic.(*dynamicfake.FakeDynamicClient).Actions())
	if err := c.observe(ctx, image, "sha256:target", key); err != nil {
		t.Fatal(err)
	}
	actions := c.Dynamic.(*dynamicfake.FakeDynamicClient).Actions()[before:]
	for _, a := range actions {
		if a.GetVerb() == "patch" {
			t.Fatal("unchanged reset patched repeatedly")
		}
	}
}
