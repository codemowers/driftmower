package scanner

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	authv1 "k8s.io/api/authentication/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	ktesting "k8s.io/client-go/testing"
	"k8s.io/client-go/tools/cache"
)

func workloadConsumer() *corev1.Pod {
	return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "backend", Namespace: "tenant", UID: "consumer-uid"}, Spec: corev1.PodSpec{NodeName: "node-a", ServiceAccountName: "privileged-workload", ImagePullSecrets: []corev1.LocalObjectReference{{Name: "private-registry"}, {Name: "private-registry"}}}, Status: corev1.PodStatus{Phase: corev1.PodRunning, ContainerStatuses: []corev1.ContainerStatus{{Name: "backend", ImageID: testRef}}}}
}

func TestWorkloadScanUsesConsumerNamespaceCredentialsAndFreshIdentity(t *testing.T) {
	ctx := context.Background()
	c, image, _ := testController(t, 2)
	c.Config.Strategy = StrategyWorkloadNamespace
	c.Config.PullSecrets = []string{"scanner-registry"}
	source := workloadConsumer()
	client := c.Kube.(*fake.Clientset)
	client.PrependReactor("create", "pods", func(a ktesting.Action) (bool, runtime.Object, error) {
		a.(ktesting.CreateAction).GetObject().(*corev1.Pod).UID = "scan-uid"
		return false, nil, nil
	})
	_, _ = client.CoreV1().Pods(source.Namespace).Create(ctx, source, metav1.CreateOptions{})
	original := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "scanner-registry", Namespace: c.Config.Namespace}, Type: corev1.SecretTypeDockerConfigJson, Data: map[string][]byte{corev1.DockerConfigJsonKey: []byte(`{"auths":{"scanner.example":{"auth":"test"}}}`)}}
	_, _ = client.CoreV1().Secrets(c.Config.Namespace).Create(ctx, original, metav1.CreateOptions{})
	// Workload credential values must never be read by the operator.
	client.PrependReactor("get", "secrets", func(a ktesting.Action) (bool, runtime.Object, error) {
		if a.(ktesting.GetAction).GetName() == "private-registry" {
			t.Fatal("read workload credential values")
		}
		return false, nil, nil
	})
	// Use the source UID actually stored by the fake API.
	source, _ = client.CoreV1().Pods(source.Namespace).Get(ctx, source.Name, metav1.GetOptions{})
	nodes, _ := client.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	key := c.Config.artifactKey("sha256:target")
	started, err := c.start(ctx, pendingScan{image: image, digest: "sha256:target", arch: "amd64", key: key}, nodes.Items, []corev1.Pod{*source})
	if err != nil || !started {
		t.Fatalf("scan start: %v %v", started, err)
	}
	a := readState(t, c).Attempts[0]
	pod, err := client.CoreV1().Pods("tenant").Get(ctx, a.Pod, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if a.Namespace != "tenant" || a.Node != "node-a" || a.UID != "scan-uid" || pod.Spec.ServiceAccountName != c.Config.scanServiceAccount() {
		t.Fatalf("incorrect placement/identity: %+v", a)
	}
	if len(pod.Spec.ImagePullSecrets) != 2 || pod.Spec.ImagePullSecrets[0].Name != "private-registry" || !strings.HasPrefix(pod.Spec.ImagePullSecrets[1].Name, "scan-pull-") {
		t.Fatalf("pull refs: %+v", pod.Spec.ImagePullSecrets)
	}
	copied, err := client.CoreV1().Secrets("tenant").Get(ctx, pod.Spec.ImagePullSecrets[1].Name, metav1.GetOptions{})
	if err != nil || !bytes.Equal(copied.Data[corev1.DockerConfigJsonKey], original.Data[corev1.DockerConfigJsonKey]) {
		t.Fatalf("scanner credential unavailable: %v", err)
	}
	sa, err := client.CoreV1().ServiceAccounts("tenant").Get(ctx, c.Config.scanServiceAccount(), metav1.GetOptions{})
	if err != nil || sa.AutomountServiceAccountToken == nil || *sa.AutomountServiceAccountToken {
		t.Fatal("scan account must not inherit workload permissions")
	}
	policy, err := client.NetworkingV1().NetworkPolicies("tenant").Get(ctx, c.Config.scanServiceAccount(), metav1.GetOptions{})
	if err != nil || len(policy.Spec.Egress) != 2 || policy.Spec.PodSelector.MatchLabels[scannerOwnerLabel] != pod.Labels[scannerOwnerLabel] {
		t.Fatalf("scan upload egress missing: %v", err)
	}
	if policy.Spec.Egress[1].To[0].NamespaceSelector.MatchLabels["kubernetes.io/metadata.name"] != c.Config.Namespace {
		t.Fatal("uploads allowed outside operator namespace")
	}
	// Observation and retention must continue after the consuming Pod disappears.
	_ = client.CoreV1().Pods("tenant").Delete(ctx, source.Name, metav1.DeleteOptions{})
	pod.Status.Phase = corev1.PodFailed
	pod.CreationTimestamp = metav1.NewTime(time.Now().Add(-49 * time.Hour))
	_, _ = client.CoreV1().Pods("tenant").Update(ctx, pod, metav1.UpdateOptions{})
	if err := c.observe(ctx, image, "sha256:target", key); err != nil {
		t.Fatal(err)
	}
	if readState(t, c).Attempts[0].Outcome != "failed" {
		t.Fatal("foreign namespace outcome not recorded")
	}
	if err := c.updateRetention(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := client.CoreV1().Pods("tenant").Get(ctx, pod.Name, metav1.GetOptions{}); err == nil {
		t.Fatal("foreign namespace diagnostic Pod not cleaned")
	}
}

func TestWorkloadScanRequiresObservedImmutableConsumer(t *testing.T) {
	c, image, _ := testController(t, 2)
	c.Config.Strategy = StrategyWorkloadNamespace
	nodes, _ := c.Kube.CoreV1().Nodes().List(context.Background(), metav1.ListOptions{})
	for _, bad := range []string{"tag-only", "terminal", "scan", "gone", "wrong-node"} {
		t.Run(bad, func(t *testing.T) {
			p := workloadConsumer()
			switch bad {
			case "tag-only":
				p.Status.ContainerStatuses[0].ImageID = "registry/app:latest"
			case "terminal":
				p.Status.Phase = corev1.PodSucceeded
			case "scan":
				p.Labels = map[string]string{"driftmower-scan": "driftmower-scan"}
			case "gone":
				now := metav1.Now()
				p.DeletionTimestamp = &now
			case "wrong-node":
				p.Spec.NodeName = "absent"
			}
			if _, ok := c.nextAttempt(image, scanState{}, nodes.Items, "amd64", "sha256:target", "key", []corev1.Pod{*p}); ok {
				t.Fatal("selected invalid consumer")
			}
		})
	}
	source := workloadConsumer()
	if _, err := c.Kube.CoreV1().Pods("tenant").Create(context.Background(), source, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	a, ok := c.nextAttempt(image, scanState{}, nodes.Items, "amd64", "sha256:target", "key", []corev1.Pod{*source})
	if !ok {
		t.Fatal("no consumer selected")
	}
	source.UID = "replacement"
	_, _ = c.Kube.CoreV1().Pods("tenant").Update(context.Background(), source, metav1.UpdateOptions{})
	if _, err := c.prepareWorkloadScan(context.Background(), image, "sha256:target", a); err == nil {
		t.Fatal("accepted replaced consumer")
	}
}

func TestWorkloadUploadRequiresRecordedPodUIDAndKeepsReadersLocal(t *testing.T) {
	c, image, _ := testController(t, 1)
	c.Config.Strategy = StrategyWorkloadNamespace
	c.Config.MaxBytes = 64 << 20
	c.Config.Audience = "scan-tests"
	key := c.Config.artifactKey("sha256:target")
	pod := ScanPod(c.Config, key, image.GetName(), string(image.GetUID()), testRef, "node-a", "amd64", "scan")
	pod.Namespace = "tenant"
	pod.UID = "scan-uid"
	pod.Annotations["driftmower.io/platform-digest"] = "sha256:target"
	_, _ = c.Kube.CoreV1().Pods("tenant").Create(context.Background(), pod, metav1.CreateOptions{})
	state := scanState{Key: key, Digest: "sha256:target", Attempts: []scanAttempt{{Pod: pod.Name, Namespace: pod.Namespace, UID: pod.UID}}}
	if err := c.saveScanState(context.Background(), image, "sha256:target", state); err != nil {
		t.Fatal(err)
	}
	client := c.Kube.(*fake.Clientset)
	namespace, uid, account := "tenant", "scan-uid", c.Config.scanServiceAccount()
	client.PrependReactor("create", "tokenreviews", func(ktesting.Action) (bool, runtime.Object, error) {
		return true, &authv1.TokenReview{Status: authv1.TokenReviewStatus{Authenticated: true, Audiences: []string{c.Config.Audience}, User: authv1.UserInfo{Username: "system:serviceaccount:" + namespace + ":" + account, Extra: map[string]authv1.ExtraValue{"authentication.kubernetes.io/pod-name": {pod.Name}, "authentication.kubernetes.io/pod-uid": {uid}}}}}, nil
	})
	handler := c.Handler()
	upload := func() int {
		req := httptest.NewRequest("PUT", "/internal/scans/scan", strings.NewReader(`{"sizeBytes":40000000}`))
		req.Header.Set("Authorization", "Bearer test")
		req.Header.Set("Content-Type", OversizedSBOMMediaType)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		return w.Code
	}
	if got := upload(); got != 413 {
		t.Fatalf("authorized cross-namespace upload: %d", got)
	}
	uid = "wrong"
	if got := upload(); got != 403 {
		t.Fatalf("wrong token UID: %d", got)
	}
	uid = "scan-uid"
	state.Attempts[0].UID = "replaced"
	if err := c.saveScanState(context.Background(), image, "sha256:target", state); err != nil {
		t.Fatal(err)
	}
	if got := upload(); got != 503 {
		t.Fatalf("unrecorded Pod accepted: %d", got)
	}
	account = c.Config.readerServiceAccount()
	req := httptest.NewRequest("POST", "/v1/findings", strings.NewReader(`{"keys":["`+key+`"]}`))
	req.Header.Set("Authorization", "Bearer test")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != 401 {
		t.Fatal("reader authentication escaped release namespace")
	}
	// The global dispatch ceiling includes foreign namespace failures.
	c.podStore = cache.NewStore(cache.MetaNamespaceKeyFunc)
	pod.Status.Phase = corev1.PodFailed
	_ = c.podStore.Add(pod)
	c.Config.MaxFailedPods = 1
	c.Log = slog.Default()
	if c.dispatchAllowed() {
		t.Fatal("foreign namespace failure escaped dispatch limit")
	}
	// Namespace survives serialization across operator restarts.
	b, _ := json.Marshal(state)
	var restored scanState
	_ = json.Unmarshal(b, &restored)
	if c.attemptNamespace(restored.Attempts[0]) != "tenant" {
		t.Fatal("attempt namespace lost")
	}
}
