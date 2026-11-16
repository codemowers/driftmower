package scanner

import (
	"context"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestAttemptRetentionRequiresDurableOutcome(t *testing.T) {
	for _, tc := range []struct {
		name    string
		phase   corev1.PodPhase
		outcome string
		age     time.Duration
		deleted bool
	}{
		{"success", corev1.PodSucceeded, "succeeded", 3 * time.Minute, true},
		{"recent success", corev1.PodSucceeded, "succeeded", time.Minute, false},
		{"failure", corev1.PodFailed, "failed", 49 * time.Hour, true},
		{"recent failure", corev1.PodFailed, "failed", time.Hour, false},
		{"unrecorded failure", corev1.PodFailed, "", 49 * time.Hour, false},
		{"active", corev1.PodRunning, "", 49 * time.Hour, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, image, key := testController(t, 1)
			if err := dispatchTest(t, c, image, key); err != nil {
				t.Fatal(err)
			}
			pod := currentPod(t, c)
			pod.CreationTimestamp = metav1.NewTime(time.Now().Add(-tc.age))
			if _, err := c.Kube.CoreV1().Pods("test").Update(context.Background(), pod, metav1.UpdateOptions{}); err != nil {
				t.Fatal(err)
			}
			pod.Status.Phase = tc.phase
			if _, err := c.Kube.CoreV1().Pods("test").UpdateStatus(context.Background(), pod, metav1.UpdateOptions{}); err != nil {
				t.Fatal(err)
			}
			state := readState(t, c)
			state.Attempts[0].Outcome = tc.outcome
			live, err := c.Dynamic.Resource(images).Get(context.Background(), image.GetName(), metav1.GetOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if err := c.saveScanState(context.Background(), live, "sha256:target", state); err != nil {
				t.Fatal(err)
			}
			if err := c.updateRetention(context.Background()); err != nil {
				t.Fatal(err)
			}
			_, err = c.Kube.CoreV1().Pods("test").Get(context.Background(), pod.Name, metav1.GetOptions{})
			if apierrors.IsNotFound(err) != tc.deleted {
				t.Fatalf("deleted=%v error=%v", tc.deleted, err)
			}
		})
	}
}

func TestExpiredSupersededScanDoesNotBlockNewConfiguration(t *testing.T) {
	for _, tc := range []struct {
		age         time.Duration
		mountFailed bool
	}{{time.Minute, false}, {16 * time.Minute, false}, {time.Minute, true}} {
		age := tc.age
		c, image, key := testController(t, 1)
		if err := dispatchTest(t, c, image, key); err != nil {
			t.Fatal(err)
		}
		pod := currentPod(t, c)
		pod.CreationTimestamp = metav1.NewTime(time.Now().Add(-age))
		pod.Annotations["driftmower.io/platform-digest"] = "sha256:target"
		if _, err := c.Kube.CoreV1().Pods("test").Update(context.Background(), pod, metav1.UpdateOptions{}); err != nil {
			t.Fatal(err)
		}
		if tc.mountFailed {
			pod.Status.InitContainerStatuses = []corev1.ContainerStatus{{Name: "trivy", State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "ErrImageNeverPull"}}}}
			if _, err := c.Kube.CoreV1().Pods("test").UpdateStatus(context.Background(), pod, metav1.UpdateOptions{}); err != nil {
				t.Fatal(err)
			}
		}
		c.Config.Image = "new-scanner"
		if err := c.updateRetention(context.Background()); err != nil {
			t.Fatal(err)
		}
		_, err := c.Kube.CoreV1().Pods("test").Get(context.Background(), pod.Name, metav1.GetOptions{})
		if apierrors.IsNotFound(err) != (age > 15*time.Minute || tc.mountFailed) {
			t.Fatalf("age %s: %v", age, err)
		}
	}
}
