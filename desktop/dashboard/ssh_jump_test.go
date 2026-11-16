package dashboard

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

func jumpCluster(host string) *clientcmdapi.Cluster {
	body, _ := json.Marshal(map[string]string{"sshJumpHost": host})
	return &clientcmdapi.Cluster{Server: "https://private.example:6443", Extensions: map[string]runtime.Object{desktopExtension: &runtime.Unknown{Raw: body}}}
}
func TestSSHJumpExtensionAndContextIdentity(t *testing.T) {
	for _, host := range []string{"-oProxyCommand=bad", "user@host\ncommand", "user name@host", "path/host"} {
		if _, err := jumpHostForCluster(jumpCluster(host)); err == nil {
			t.Fatalf("accepted %q", host)
		}
	}
	cluster := jumpCluster("user@bastion")
	if host, err := jumpHostForCluster(cluster); err != nil || host != "user@bastion" {
		t.Fatal(host, err)
	}
	cluster.ProxyURL = "socks5://localhost:1080"
	if _, err := jumpHostForCluster(cluster); err == nil {
		t.Fatal("combined proxy transports accepted")
	}
	raw := clientcmdapi.NewConfig()
	raw.Clusters["one"] = jumpCluster("bastion-one")
	raw.Clusters["two"] = jumpCluster("bastion-two")
	raw.AuthInfos["admin"] = &clientcmdapi.AuthInfo{Token: "example"}
	raw.Contexts["one"] = &clientcmdapi.Context{Cluster: "one", AuthInfo: "admin"}
	raw.Contexts["two"] = &clientcmdapi.Context{Cluster: "two", AuthInfo: "admin"}
	raw.Contexts["alias"] = &clientcmdapi.Context{Cluster: "one", AuthInfo: "admin", Namespace: "team"}
	if groups := contextGroups(raw); len(groups) != 2 {
		t.Fatalf("jump-host routes merged or namespace aliases split: %+v", groups)
	}
}
func TestSSHJumpManagerReusesReconnectsPrunesAndCloses(t *testing.T) {
	manager := newSSHJumps(context.Background())
	defer manager.Close()
	var starts atomic.Int32
	var last *sshJump
	manager.start = func(ctx context.Context, _, _ string) (*sshJump, error) {
		starts.Add(1)
		child, cancel := context.WithCancel(ctx)
		tunnel := &sshJump{address: "127.0.0.1:12345", cancel: cancel, done: make(chan struct{})}
		last = tunnel
		go func() { <-child.Done(); close(tunnel.done) }()
		return tunnel, nil
	}
	for range 2 {
		if _, err := manager.address("jump", "https://private.example"); err != nil {
			t.Fatal(err)
		}
	}
	if starts.Load() != 1 {
		t.Fatal("tunnel not reused")
	}
	last.cancel()
	<-last.done
	if _, err := manager.address("jump", "https://private.example"); err != nil {
		t.Fatal(err)
	}
	if starts.Load() != 2 {
		t.Fatal("closed tunnel not reconnected")
	}
	manager.prune(nil)
	select {
	case <-last.done:
	default:
		t.Fatal("removed tunnel remains alive")
	}
	manager.Close()
	if _, err := manager.address("jump", "https://private.example"); !errors.Is(err, context.Canceled) {
		t.Fatal("closed manager started a tunnel", err)
	}
}
func TestSSHJumpUsesLoopbackForAllTransportsAndPreservesTLSIdentity(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Host, "127.0.0.1:") {
			t.Errorf("host changed: %s", r.Host)
		}
		_, _ = w.Write([]byte("ok"))
	}))
	defer server.Close()
	local, _ := url.Parse(server.URL)
	cfg := &rest.Config{Host: "https://private.example:6443", TLSClientConfig: rest.TLSClientConfig{ServerName: "example.com"}}
	if err := configureSSHJump(cfg, local.Host); err != nil {
		t.Fatal(err)
	}
	// The test server certificate is trusted by its own client; retain its TLS
	// configuration while exercising the loopback endpoint and original TLS identity.
	transport := server.Client().Transport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{RootCAs: transport.TLSClientConfig.RootCAs, ServerName: "example.com", MinVersion: tls.VersionTLS12}
	transport.DialContext = cfg.Dial
	response, err := (&http.Client{Transport: transport}).Get(cfg.Host)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if cfg.Host != server.URL || cfg.ServerName != "example.com" || cfg.Insecure {
		t.Fatal("TLS identity changed", cfg.Host, cfg.ServerName, cfg.Insecure)
	}
	if cfg.Dial != nil {
		t.Fatal("streaming must not depend on a custom Dial callback")
	}
	original := &rest.Config{Host: "https://api.example:6443/prefix"}
	if err := configureSSHJump(original, local.Host); err != nil {
		t.Fatal(err)
	}
	if original.ServerName != "api.example" || original.Host != server.URL+"/prefix" {
		t.Fatal("original TLS name or API prefix lost", original.Host, original.ServerName)
	}

}
func TestSSHJumpLive(t *testing.T) {
	if os.Getenv("DRIFTMOWER_TEST_SSH_JUMP") != "1" {
		t.Skip("explicit local SSH jump-host integration test")
	}
	raw, err := clientcmd.NewDefaultClientConfigLoadingRules().Load()
	if err != nil {
		t.Fatal(err)
	}
	name := os.Getenv("DRIFTMOWER_TEST_SSH_JUMP_CONTEXT")
	if name == "" {
		t.Skip("set DRIFTMOWER_TEST_SSH_JUMP_CONTEXT to an existing SSH-jump context")
	}
	entry := raw.Contexts[name]
	if entry == nil {
		t.Fatal("imported context missing")
	}
	cluster := raw.Clusters[entry.Cluster]
	host, err := jumpHostForCluster(cluster)
	if err != nil || host == "" {
		t.Fatal(host, err)
	}
	manager := newSSHJumps(context.Background())
	defer manager.Close()
	address, err := manager.address(host, cluster.Server)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := clientcmd.NewNonInteractiveClientConfig(*raw, name, &clientcmd.ConfigOverrides{}, nil).ClientConfig()
	if err != nil {
		t.Fatal(err)
	}
	cfg.Timeout = 10 * time.Second
	if err := configureSSHJump(cfg, address); err != nil {
		t.Fatal(err)
	}
	client, err := rest.HTTPClientFor(cfg)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Get(strings.TrimRight(cfg.Host, "/") + "/readyz")
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal("API readiness", response.StatusCode)
	}
	discovery := &ContextDiscovery{ctx: context.Background(), jumps: manager, kubeLogin: true}
	result := discovery.inspectContext(raw, name, "integration", func(server string) error { return dial(context.Background(), server) })
	if result.Status != "MCP is not installed" && result.Status != "available" {
		t.Fatalf("discovery over SSH: %+v", result)
	}
	manager.Close()
	if conn, err := net.DialTimeout("tcp", address, time.Second); err == nil {
		_ = conn.Close()
		t.Fatal("SSH listener leaked after shutdown")
	}
	t.Log("Verified API readiness and desktop discovery over SSH with original TLS identity; listener cleaned up. Status:", result.Status)
}
