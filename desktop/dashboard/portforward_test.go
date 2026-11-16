package dashboard

import (
	"context"
	"net"
	"net/url"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"
)

func TestDesktopForwardIdentityReuseReconnectAndCleanup(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wake := make(chan struct{}, 1)
	m := newDesktopForwards(ctx, wake)
	t.Cleanup(m.Close)
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "mcp-1", Namespace: "driftmower", UID: types.UID("pod-1"), Labels: map[string]string{"app": "mcp"}}, Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "app", Ports: []corev1.ContainerPort{{Name: "api", ContainerPort: 3123}}}}}, Status: corev1.PodStatus{Phase: corev1.PodRunning, Conditions: []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}}}}
	client := fake.NewClientset(pod)
	service := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "mcp", Namespace: "driftmower", UID: "service-1"}, Spec: corev1.ServiceSpec{Selector: map[string]string{"app": "mcp"}, Ports: []corev1.ServicePort{{Name: "mcp", Port: 3000, TargetPort: intstr.FromString("api")}}}}
	var starts atomic.Int32
	var forwards []*desktopForward
	fail := make(chan struct{})
	m.start = func(_ context.Context, cfg *rest.Config, _ kubernetes.Interface, _ *corev1.Pod, remote int, local uint16) (*desktopForward, error) {
		if remote != 3123 {
			t.Errorf("forwarded service port instead of Pod target: %d", remote)
		}
		if cfg.ExecProvider != nil {
			t.Error("forwarder would run a credential plugin")
		}
		listener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(int(local))))
		if err != nil {
			return nil, err
		}
		port := uint16(listener.Addr().(*net.TCPAddr).Port)
		f := &desktopForward{url: "http://" + listener.Addr().String() + "/mcp", port: port, stop: make(chan struct{}), done: make(chan struct{})}
		forwards = append(forwards, f)
		first := starts.Add(1) == 1
		go func() {
			if first {
				select {
				case <-fail:
				case <-f.stop:
				}
			} else {
				<-f.stop
			}
			listener.Close()
			close(f.done)
		}()
		return f, nil
	}
	get := func(key string) string {
		t.Helper()
		endpoint, err := m.service(ctx, key, &rest.Config{}, client, service)
		if err != nil {
			t.Fatal(err)
		}
		return endpoint
	}
	one := get("certificate-identity")
	if again := get("certificate-identity"); again != one || starts.Load() != 1 {
		t.Fatal("duplicate tunnel on discovery refresh")
	}
	two := get("different-token-identity")
	if two == one || starts.Load() != 2 {
		t.Fatal("different identities shared a tunnel")
	}
	close(fail)
	select {
	case <-wake:
	case <-ctx.Done():
		t.Fatal("disconnection did not wake discovery")
	}
	if next := get("certificate-identity"); next != one || starts.Load() != 3 {
		t.Fatal("reconnect changed local endpoint or failed to restart")
	}
	updated, err := client.CoreV1().Pods("driftmower").Get(ctx, pod.Name, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	updated.UID = "pod-2"
	if _, err = client.CoreV1().Pods("driftmower").Update(ctx, updated, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if next := get("certificate-identity"); next != one || starts.Load() != 4 {
		t.Fatal("Pod replacement did not preserve the local endpoint")
	}
	m.prune(map[string]bool{"certificate-identity": true})
	select {
	case <-forwards[1].done:
	case <-ctx.Done():
		t.Fatal("obsolete context tunnel was not closed")
	}
	m.Close()
	for _, f := range forwards {
		select {
		case <-f.done:
		case <-ctx.Done():
			t.Fatal("tunnel survived desktop shutdown")
		}
	}
	for _, endpoint := range []string{one, two} {
		u, _ := url.Parse(endpoint)
		if conn, err := net.DialTimeout("tcp", u.Host, time.Second); err == nil {
			conn.Close()
			t.Fatal("listener survived shutdown")
		}
	}
}

func TestDesktopForwardRequiresReadyPodAndServiceSelector(t *testing.T) {
	m := newDesktopForwards(context.Background(), nil)
	defer m.Close()
	client := fake.NewClientset()
	service := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: "driftmower"}}
	if _, err := m.service(context.Background(), "one", &rest.Config{}, client, service); err == nil {
		t.Fatal("selectorless service forwarded")
	}
	service.Spec.Selector = map[string]string{"app": "mcp"}
	if _, err := m.service(context.Background(), "one", &rest.Config{}, client, service); err == nil {
		t.Fatal("service without Ready Pods forwarded")
	}
}
