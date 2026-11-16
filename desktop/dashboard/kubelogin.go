package dashboard

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

// How long a sign-in may wait for the person to finish in the browser.
const signInTimeout = 5 * time.Minute

// Directories GUI sessions often leave out of PATH, where kubectl, krew's
// kubectl-oidc_login and kubelogin are installed.
func pluginPath() string {
	dirs := filepath.SplitList(os.Getenv("PATH"))
	if home, err := os.UserHomeDir(); err == nil {
		dirs = append(dirs, filepath.Join(home, ".krew", "bin"), filepath.Join(home, ".local", "bin"), filepath.Join(home, "go", "bin"))
	}
	if root := os.Getenv("KREW_ROOT"); root != "" {
		dirs = append(dirs, filepath.Join(root, "bin"))
	}
	dirs = append(dirs, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin")

	return strings.Join(dirs, string(filepath.ListSeparator))
}

// lookPath finds command in path, as exec.LookPath would with that PATH.
func lookPath(command, path string) (string, error) {
	for _, dir := range filepath.SplitList(path) {
		candidate := filepath.Join(dir, command)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return candidate, nil
		}
	}

	return "", fmt.Errorf("%s not found; install kubelogin (kubectl krew install oidc-login)", command)
}

// usesOIDCLogin says whether a kubeconfig user signs in with kubelogin.
func usesOIDCLogin(auth *clientcmdapi.AuthInfo) bool {
	if auth == nil || auth.Exec == nil {
		return false
	}
	_, ok := oidcLoginFlags(auth.Exec)

	return ok
}

// signIns runs one kubelogin per issuer and client at a time; a second
// request for the same login waits for the first.
type signIns struct {
	mu      sync.Mutex
	running map[string]*signIn
}

type signIn struct {
	done chan struct{}
	err  error
}

func (s *signIns) do(key string, run func() error) error {
	s.mu.Lock()
	if s.running == nil {
		s.running = map[string]*signIn{}
	}
	if current, ok := s.running[key]; ok {
		s.mu.Unlock()
		<-current.done

		return current.err
	}
	current := &signIn{done: make(chan struct{})}
	s.running[key] = current
	s.mu.Unlock()

	current.err = run()
	s.mu.Lock()
	delete(s.running, key)
	s.mu.Unlock()
	close(current.done)

	return current.err
}

// runOIDCLogin runs a context's kubelogin exec plugin as kubectl would:
// the kubeconfig's command, arguments and environment, with
// KUBERNETES_EXEC_INFO. kubelogin refreshes its cached tokens or opens the
// default browser, and writes the result to its token cache, which
// discovery reads. Only kubelogin is run, never other credential plugins.
// It returns the ID token kubelogin printed, which holds also when kubelogin
// keeps its cache in the OS keyring.
func runOIDCLogin(ctx context.Context, auth *clientcmdapi.AuthInfo) (string, error) {
	if !usesOIDCLogin(auth) {
		return "", errors.New("this context does not sign in with kubelogin")
	}
	plugin := auth.Exec
	path := pluginPath()
	command := plugin.Command
	switch {
	case filepath.IsAbs(command):
	case strings.ContainsRune(command, filepath.Separator):
		// client-go resolves relative commands against the kubeconfig's directory.
		command = filepath.Join(filepath.Dir(auth.LocationOfOrigin), command)
	default:
		var err error
		if command, err = lookPath(command, path); err != nil {
			return "", err
		}
	}
	info, _ := json.Marshal(map[string]any{
		"apiVersion": plugin.APIVersion, "kind": "ExecCredential", "spec": map[string]any{"interactive": false},
	})

	ctx, cancel := context.WithTimeout(ctx, signInTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, command, plugin.Args...)
	cmd.Env = append(os.Environ(), "PATH="+path, "KUBERNETES_EXEC_INFO="+string(info))
	for _, e := range plugin.Env {
		cmd.Env = append(cmd.Env, e.Name+"="+e.Value)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return "", errors.New("sign-in was not completed in the browser in time")
		}
		if msg := lastLine(stderr.String()); msg != "" {
			return "", fmt.Errorf("kubelogin: %s", msg)
		}

		return "", fmt.Errorf("kubelogin: %w", err)
	}
	var credential struct {
		Status struct {
			Token string `json:"token"`
		} `json:"status"`
	}
	if json.Unmarshal(stdout.Bytes(), &credential) != nil || credential.Status.Token == "" {
		return "", errors.New("kubelogin returned no token")
	}

	return credential.Status.Token, nil
}

// loginKey identifies a kubelogin login: tokens are per issuer and client.
func loginKey(auth *clientcmdapi.AuthInfo) string {
	flags, _ := oidcLoginFlags(auth.Exec)

	key := strings.TrimRight(flags["oidc-issuer-url"], "/") + " " + flags["oidc-client-id"]
	if dir := flags["token-cache-dir"]; dir != "" {
		key += " " + dir
	}
	return key
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")

	return strings.TrimSpace(lines[len(lines)-1])
}
