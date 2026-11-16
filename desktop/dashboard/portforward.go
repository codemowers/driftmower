package dashboard

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"sync"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/util/httpstream"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/portforward"
	"k8s.io/client-go/transport/spdy"
)

type desktopForward struct {
	url  string
	port uint16
	stop chan struct{}
	done chan struct{}
	err  error // read only after done closes
	once sync.Once
}

func (f *desktopForward) close() { f.once.Do(func() { close(f.stop) }) }

type forwardEntry struct {
	mu      sync.Mutex
	target  string
	forward *desktopForward
}

type desktopForwards struct {
	ctx     context.Context
	cancel  context.CancelFunc
	mu      sync.Mutex
	entries map[string]*forwardEntry
	wake    chan<- struct{}
	start   func(context.Context, *rest.Config, kubernetes.Interface, *corev1.Pod, int, uint16) (*desktopForward, error)
}

func newDesktopForwards(ctx context.Context, wake chan<- struct{}) *desktopForwards {
	ctx, cancel := context.WithCancel(ctx)
	return &desktopForwards{ctx: ctx, cancel: cancel, entries: map[string]*forwardEntry{}, wake: wake, start: startDesktopForward}
}

// Each key includes the API server, TLS trust and credential identity. Namespace
// aliases reuse one forward; different authentication identities never do.
func (m *desktopForwards) service(ctx context.Context, key string, config *rest.Config, client kubernetes.Interface, service *corev1.Service) (string, error) {
	if len(service.Spec.Selector) == 0 {
		return "", fmt.Errorf("MCP Service has no Pod selector")
	}
	pods, err := client.CoreV1().Pods(service.Namespace).List(ctx, metav1.ListOptions{LabelSelector: labels.SelectorFromSet(service.Spec.Selector).String()})
	if err != nil {
		return "", err
	}
	sort.Slice(pods.Items, func(i, j int) bool { return pods.Items[i].Name < pods.Items[j].Name })
	var selected *corev1.Pod
	for i := range pods.Items {
		pod := &pods.Items[i]
		if pod.DeletionTimestamp != nil || pod.Status.Phase != corev1.PodRunning {
			continue
		}
		for _, condition := range pod.Status.Conditions {
			if condition.Type == corev1.PodReady && condition.Status == corev1.ConditionTrue {
				selected = pod
				break
			}
		}
		if selected != nil {
			break
		}
	}
	if selected == nil {
		return "", fmt.Errorf("MCP has no Ready Pod to forward")
	}
	port, err := mcpTargetPort(service, selected)
	if err != nil {
		return "", err
	}
	m.mu.Lock()
	entry := m.entries[key]
	if entry == nil {
		entry = &forwardEntry{}
		m.entries[key] = entry
	}
	m.mu.Unlock()
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if err := m.ctx.Err(); err != nil {
		return "", err
	}
	target := string(service.UID) + "/" + string(selected.UID) + "/" + strconv.Itoa(port)
	localPort := uint16(0)
	if f := entry.forward; f != nil {
		localPort = f.port
		if entry.target == target {
			select {
			case <-f.done:
			default:
				return f.url, nil
			}
		}
		f.close()
		select {
		case <-f.done:
		case <-ctx.Done():
			return "", ctx.Err()
		case <-m.ctx.Done():
			return "", m.ctx.Err()
		}
	}
	f, err := m.start(ctx, config, client, selected, port, localPort)
	if err != nil {
		return "", err
	}
	entry.target, entry.forward = target, f
	go func() {
		select {
		case <-m.ctx.Done():
			f.close()
		case <-f.done:
			select {
			case <-f.stop:
				return
			default:
			}
			select {
			case m.wake <- struct{}{}:
			default:
			}
		}
	}()
	return f.url, nil
}

func (m *desktopForwards) prune(keep map[string]bool) {
	m.mu.Lock()
	var removed []*forwardEntry
	for key, entry := range m.entries {
		if !keep[key] {
			delete(m.entries, key)
			removed = append(removed, entry)
		}
	}
	m.mu.Unlock()
	for _, entry := range removed {
		entry.mu.Lock()
		if entry.forward != nil {
			entry.forward.close()
			<-entry.forward.done
		}
		entry.mu.Unlock()
	}
}
func (m *desktopForwards) Close() { m.cancel(); m.prune(nil) }

func (m *desktopForwards) drop(key string) {
	m.mu.Lock()
	entry := m.entries[key]
	delete(m.entries, key)
	m.mu.Unlock()
	if entry != nil {
		entry.mu.Lock()
		if entry.forward != nil {
			entry.forward.close()
			<-entry.forward.done
		}
		entry.mu.Unlock()
	}
}

func forwardIdentityKey(key string, profile *ChromeProfile) string {
	if profile != nil && profile.Directory != "" {
		return key + "/chrome/" + profile.Directory
	}
	return key
}

func mcpTargetPort(service *corev1.Service, pod *corev1.Pod) (int, error) {
	for _, p := range service.Spec.Ports {
		if p.Protocol != "" && p.Protocol != corev1.ProtocolTCP {
			continue
		}
		if p.Name != "mcp" && p.Port != 3000 && len(service.Spec.Ports) != 1 {
			continue
		}
		if p.TargetPort.Type == intstr.Int {
			if p.TargetPort.IntVal != 0 {
				return int(p.TargetPort.IntVal), nil
			}
			return int(p.Port), nil
		}
		for _, c := range pod.Spec.Containers {
			for _, cp := range c.Ports {
				if cp.Name == p.TargetPort.StrVal && (cp.Protocol == "" || cp.Protocol == corev1.ProtocolTCP) {
					return int(cp.ContainerPort), nil
				}
			}
		}
	}
	return 0, fmt.Errorf("MCP Service has no resolvable MCP port")
}

func startDesktopForward(ctx context.Context, config *rest.Config, client kubernetes.Interface, pod *corev1.Pod, port int, local uint16) (*desktopForward, error) {
	endpoint := client.CoreV1().RESTClient().Post().Namespace(pod.Namespace).Resource("pods").Name(pod.Name).SubResource("portforward").URL()
	transport, upgrader, err := spdy.RoundTripperFor(config)
	if err != nil {
		return nil, err
	}
	websocket, err := portforward.NewSPDYOverWebsocketDialer(endpoint, config)
	if err != nil {
		return nil, err
	}
	dialer := portforward.NewFallbackDialer(websocket, spdy.NewDialer(upgrader, &http.Client{Transport: transport}, http.MethodPost, endpoint), func(err error) bool { return httpstream.IsUpgradeFailure(err) || httpstream.IsHTTPSProxyError(err) })
	f := &desktopForward{stop: make(chan struct{}), done: make(chan struct{})}
	ready := make(chan struct{})
	pf, err := portforward.NewOnAddresses(dialer, []string{"127.0.0.1"}, []string{fmt.Sprintf("%d:%d", local, port)}, f.stop, ready, io.Discard, io.Discard)
	if err != nil {
		return nil, err
	}
	go func() { f.err = pf.ForwardPorts(); close(f.done) }()
	select {
	case <-ctx.Done():
		f.close()
		return nil, ctx.Err()
	case <-f.done:
		return nil, fmt.Errorf("MCP port-forward failed: %v", f.err)
	case <-ready:
		ports, err := pf.GetPorts()
		if err != nil || len(ports) != 1 {
			f.close()
			return nil, fmt.Errorf("MCP port-forward did not bind a local port")
		}
		f.port = ports[0].Local
		f.url = fmt.Sprintf("http://127.0.0.1:%d/mcp", f.port)
		return f, nil
	}
}
