package dashboard

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"k8s.io/client-go/rest"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

func jumpHostForCluster(cluster *clientcmdapi.Cluster) (string, error) {
	if cluster == nil || cluster.Extensions[desktopExtension] == nil {
		return "", nil
	}
	body, err := json.Marshal(cluster.Extensions[desktopExtension])
	if err != nil {
		return "", err
	}
	var settings struct {
		SSHJumpHost string `json:"sshJumpHost"`
	}
	if err := json.Unmarshal(body, &settings); err != nil {
		return "", fmt.Errorf("invalid desktop cluster extension: %w", err)
	}
	host := settings.SSHJumpHost
	if host != "" && (strings.HasPrefix(host, "-") || strings.ContainsAny(host, " \t\r\n\x00") || strings.Contains(host, "/")) {
		return "", errors.New("invalid SSH jump host; use an SSH host alias or user@host")
	}
	if host != "" && cluster.ProxyURL != "" {
		return "", errors.New("SSH jump host and proxy-url cannot be combined")
	}
	return host, nil
}

type sshJump struct {
	address string
	cancel  context.CancelFunc
	done    chan struct{}
	err     error // Read only after done closes.
}
type sshJumpEntry struct {
	mu     sync.Mutex
	tunnel *sshJump
}
type sshJumps struct {
	ctx     context.Context
	cancel  context.CancelFunc
	mu      sync.Mutex
	entries map[string]*sshJumpEntry
	start   func(context.Context, string, string) (*sshJump, error)
}

func newSSHJumps(ctx context.Context) *sshJumps {
	ctx, cancel := context.WithCancel(ctx)
	return &sshJumps{ctx: ctx, cancel: cancel, entries: map[string]*sshJumpEntry{}, start: startSSHJump}
}
func sshJumpKey(host, server string) string { return host + "\x00" + server }
func (m *sshJumps) address(host, server string) (string, error) {
	key := sshJumpKey(host, server)
	m.mu.Lock()
	entry := m.entries[key]
	if entry == nil {
		entry = &sshJumpEntry{}
		m.entries[key] = entry
	}
	m.mu.Unlock()
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if err := m.ctx.Err(); err != nil {
		return "", err
	}
	if entry.tunnel != nil {
		select {
		case <-entry.tunnel.done:
		default:
			return entry.tunnel.address, nil
		}
	}
	tunnel, err := m.start(m.ctx, host, server)
	if err != nil {
		return "", err
	}
	entry.tunnel = tunnel
	return tunnel.address, nil
}
func (m *sshJumps) prune(keep map[string]bool) {
	m.mu.Lock()
	var removed []*sshJumpEntry
	for key, entry := range m.entries {
		if !keep[key] {
			delete(m.entries, key)
			removed = append(removed, entry)
		}
	}
	m.mu.Unlock()
	for _, entry := range removed {
		entry.mu.Lock()
		if entry.tunnel != nil {
			entry.tunnel.cancel()
			<-entry.tunnel.done
		}
		entry.mu.Unlock()
	}
}
func (m *sshJumps) Close() { m.cancel(); m.prune(nil) }

func startSSHJump(parent context.Context, host, server string) (*sshJump, error) {
	u, err := url.Parse(server)
	if err != nil || u.Hostname() == "" || u.User != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, errors.New("invalid Kubernetes API URL for SSH jump host")
	}
	port := u.Port()
	if port == "" {
		port = "443"
		if u.Scheme == "http" {
			port = "80"
		}
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	address := listener.Addr().String()
	localPort := strconv.Itoa(listener.Addr().(*net.TCPAddr).Port)
	if err := listener.Close(); err != nil {
		return nil, err
	}
	forward := "127.0.0.1:" + localPort + ":" + net.JoinHostPort(u.Hostname(), port)
	// Reuse an existing configured SSH master, which may be the only live
	// route to this host. Own only the new forwarding rule, never the master.
	check, checkCancel := context.WithTimeout(parent, 2*time.Second)
	masterErr := exec.CommandContext(check, "ssh", "-O", "check", "-o", "BatchMode=yes", "--", host).Run()
	checkCancel()
	if masterErr == nil {
		request, requestCancel := context.WithTimeout(parent, 5*time.Second)
		output, err := exec.CommandContext(request, "ssh", "-O", "forward", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-L", forward, "--", host).CombinedOutput()
		requestCancel()
		if err != nil {
			cleanup, stop := context.WithTimeout(context.Background(), 3*time.Second)
			_ = exec.CommandContext(cleanup, "ssh", "-O", "cancel", "-L", forward, "--", host).Run()
			stop()
			return nil, fmt.Errorf("SSH master forward: %w: %s", err, strings.TrimSpace(string(output)))
		}
		ctx, cancel := context.WithCancel(parent)
		tunnel := &sshJump{address: address, cancel: cancel, done: make(chan struct{})}
		go func() {
			defer close(tunnel.done)
			defer func() {
				cleanup, stop := context.WithTimeout(context.Background(), 3*time.Second)
				defer stop()
				// Cancel this exact listener; do not exit somebody else's SSH master.
				_ = exec.CommandContext(cleanup, "ssh", "-O", "cancel", "-L", forward, "--", host).Run()
			}()
			ticker := time.NewTicker(10 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					probe, stop := context.WithTimeout(ctx, 2*time.Second)
					err := exec.CommandContext(probe, "ssh", "-O", "check", "-o", "BatchMode=yes", "--", host).Run()
					stop()
					if err != nil {
						tunnel.err = fmt.Errorf("SSH master for %s disconnected: %w", host, err)
						return
					}
				}
			}
		}()
		return tunnel, nil
	}
	ctx, cancel := context.WithCancel(parent)
	// Use OpenSSH's existing agent, host-key verification and ~/.ssh/config.
	// Own this connection rather than altering or closing a shared SSH master.
	args := []string{"-N", "-T", "-S", "none", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "-L", forward, "--", host}
	cmd := exec.CommandContext(ctx, "ssh", args...)
	cmd.Stdout = io.Discard
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		cancel()
		return nil, err
	}
	tunnel := &sshJump{address: address, cancel: cancel, done: make(chan struct{})}
	go func() {
		err := cmd.Wait()
		if err != nil {
			tunnel.err = fmt.Errorf("SSH jump host %s: %w: %s", host, err, strings.TrimSpace(stderr.String()))
		}
		close(tunnel.done)
	}()
	startup, stop := context.WithTimeout(parent, 12*time.Second)
	defer stop()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-tunnel.done:
			cancel()
			if tunnel.err == nil {
				return nil, errors.New("SSH jump host closed before becoming ready")
			}
			return nil, tunnel.err
		case <-startup.Done():
			cancel()
			<-tunnel.done
			return nil, fmt.Errorf("SSH jump host %s: %w", host, startup.Err())
		case <-ticker.C:
			conn, err := (&net.Dialer{Timeout: 100 * time.Millisecond}).DialContext(startup, "tcp", address)
			if err == nil {
				_ = conn.Close()
				return tunnel, nil
			}
		}
	}
}

// Streaming clients do not honor rest.Config.Dial. Point all in-memory API
// transports at the loopback tunnel and retain the original TLS server name.
// The kubeconfig and the public connection identity retain the real API URL.
func configureSSHJump(config *rest.Config, local string) error {
	u, err := url.Parse(config.Host)
	if err != nil || u.Hostname() == "" {
		return errors.New("invalid Kubernetes API URL")
	}
	if config.ServerName == "" {
		config.ServerName = u.Hostname()
	}
	u.Host = local
	config.Host = u.String()
	config.Dial = nil
	config.Proxy = func(*http.Request) (*url.URL, error) { return nil, nil }
	return nil
}
