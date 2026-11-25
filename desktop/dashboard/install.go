package dashboard

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

const (
	installChart     = "oci://ghcr.io/codemowers/charts/driftmower"
	installRelease   = "driftmower"
	installNamespace = "driftmower"
	installTimeout   = 10 * time.Minute
	passmowerGroup   = "codemowers.cloud/v1"
)

// InstallOffer describes how Driftmower could be added to a cluster that has
// no MCP. Settings always shows the command; one-click install additionally
// needs a known auth mode and a local helm binary.
type InstallOffer struct {
	// rbac when the cluster has Passmower's OIDCClient API; anonymous when it
	// confirmedly has not; empty when that could not be determined.
	AuthMode string `json:"authMode,omitempty"`
	// Copyable helm command using the person's kubeconfig context.
	Command string `json:"command"`
	// Local helm executable is available for one-click install.
	Helm bool `json:"helm,omitempty"`
	// The context reaches its API server through a desktop SSH jump host,
	// which the copyable command cannot use outside the desktop.
	SSHJump bool `json:"sshJump,omitempty"`
}

// installValues are the Helm values one-click install sets. With Passmower the
// chart defaults apply. Without it, MCP runs anonymously behind a Service only,
// and its NetworkPolicy leaves Kubernetes port-forwarding (and so
// pods/portforward RBAC) as the only way in; components needing other
// platform APIs stay off, as in the deployment guide's minimal profile.
func installValues(authMode string) []string {
	values := []string{"mcp.dashboard.localOrigins={" + DesktopOrigin + "}"}
	if authMode == "anonymous" {
		values = append(values,
			"mcp.auth.mode=anonymous",
			"mcp.ingress.enabled=false",
			"mcp.publicUrl=http://127.0.0.1:3000",
			"mcp.portForwardOnly=true",
			"ui.enabled=false",
			"operator.enabled=false",
			"crawler.enabled=false",
			"registryScraper.enabled=false",
		)
	}
	return values
}

func installArgs(kubeconfig, context, authMode string) []string {
	args := []string{"upgrade", "--install", installRelease, installChart}
	if kubeconfig != "" {
		args = append(args, "--kubeconfig", kubeconfig)
	}
	args = append(args, "--kube-context", context, "--namespace", installNamespace, "--create-namespace")
	for _, value := range installValues(authMode) {
		args = append(args, "--set", value)
	}
	return args
}

func shellQuote(arg string) string {
	if arg != "" && strings.Trim(arg, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./:=@") == "" {
		return arg
	}
	return "'" + strings.ReplaceAll(arg, "'", `'\''`) + "'"
}

func installCommand(context, authMode string) string {
	args := installArgs("", context, authMode)
	quoted := make([]string, 0, len(args)+1)
	quoted = append(quoted, "helm")
	for _, arg := range args {
		quoted = append(quoted, shellQuote(arg))
	}
	return strings.Join(quoted, " ")
}

// installOffer runs only after the MCP Service lookup returned NotFound, so
// the credentials already work. A failed API discovery leaves AuthMode empty
// rather than guessing that an unauthenticated install is appropriate.
func (d *ContextDiscovery) installOffer(ctx context.Context, client kubernetes.Interface, context string, sshJump bool) *InstallOffer {
	offer := &InstallOffer{SSHJump: sshJump}
	resources, err := client.Discovery().ServerResourcesForGroupVersion(passmowerGroup)
	switch {
	case err == nil:
		offer.AuthMode = "anonymous"
		for _, resource := range resources.APIResources {
			if resource.Name == "oidcclients" {
				offer.AuthMode = "rbac"
			}
		}
	case apierrors.IsNotFound(err):
		offer.AuthMode = "anonymous"
	}
	mode := offer.AuthMode
	if mode == "" {
		mode = "anonymous"
	}
	offer.Command = installCommand(context, mode)
	if d.kubeLogin {
		_, err := lookPath("helm", pluginPath())
		offer.Helm = err == nil && offer.AuthMode != ""
	}
	return offer
}

// installs allows one install per connection at a time.
type installs struct {
	mu      sync.Mutex
	running map[string]bool
}

func (i *installs) start(key string) bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.running == nil {
		i.running = map[string]bool{}
	}
	if i.running[key] {
		return false
	}
	i.running[key] = true
	return true
}

func (i *installs) done(key string) {
	i.mu.Lock()
	delete(i.running, key)
	i.mu.Unlock()
}

// installKubeconfig writes a single-context kubeconfig holding the
// credentials discovery already resolved, so helm runs no credential plugin
// and cannot prompt. An SSH jump host's loopback forward replaces the server
// address while TLS still verifies the original API server name.
func (d *ContextDiscovery) installKubeconfig(raw *clientcmdapi.Config, name, key, dir string) (string, error) {
	raw = raw.DeepCopy()
	c := raw.Contexts[name]
	if c == nil || raw.Clusters[c.Cluster] == nil {
		return "", errors.New("invalid context configuration")
	}
	cluster := raw.Clusters[c.Cluster]
	auth := raw.AuthInfos[c.AuthInfo]
	if auth == nil {
		auth = &clientcmdapi.AuthInfo{}
	}
	jump, err := jumpHostForCluster(cluster)
	if err != nil {
		return "", err
	}
	if jump != "" {
		if d.jumps == nil {
			return "", errors.New("SSH jump hosts require the desktop application")
		}
		tunnel, err := d.jumps.address(jump, cluster.Server)
		if err != nil {
			return "", err
		}
		u, err := url.Parse(cluster.Server)
		if err != nil || u.Hostname() == "" {
			return "", errors.New("invalid Kubernetes API URL")
		}
		if cluster.TLSServerName == "" {
			cluster.TLSServerName = u.Hostname()
		}
		u.Host = tunnel
		cluster.Server = u.String()
		cluster.ProxyURL = ""
	}
	if d.chrome != nil {
		if err := d.chrome.prepare(auth, cluster.Server, key); err != nil {
			return "", err
		}
	}
	if err := StaticCredentials(auth, time.Now(), d.signedIn); err != nil {
		return "", err
	}
	if auth.Exec != nil || auth.AuthProvider != nil {
		return "", ErrExecUnsupported
	}
	cluster.Extensions, auth.Extensions = nil, nil
	single := clientcmdapi.NewConfig()
	single.Clusters["cluster"] = cluster
	single.AuthInfos["user"] = auth
	single.Contexts[name] = &clientcmdapi.Context{Cluster: "cluster", AuthInfo: "user", Namespace: installNamespace}
	single.CurrentContext = name
	if err := clientcmdapi.FlattenConfig(single); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "kubeconfig")
	if err := clientcmd.WriteToFile(*single, path); err != nil {
		return "", err
	}
	return path, os.Chmod(path, 0o600)
}

// Install deploys the Driftmower chart with helm for one discovered
// connection, then refreshes its discovery.
func (d *ContextDiscovery) Install(ctx context.Context, key string) error {
	var target *DiscoveredContext
	d.mu.RLock()
	for _, c := range d.contexts {
		if c.Key == key {
			copy := c
			target = &copy
		}
	}
	d.mu.RUnlock()
	if target == nil {
		return errors.New("connection no longer exists")
	}
	if target.Install == nil || target.Install.AuthMode == "" {
		return errors.New("this connection does not offer installation")
	}
	helm, err := lookPath("helm", pluginPath())
	if err != nil {
		return errors.New("helm not found; install Helm or run the shown command")
	}
	if !d.installs.start(key) {
		return errors.New("installation already running for this connection")
	}
	defer d.installs.done(key)
	raw, err := d.load()
	if err != nil {
		return err
	}
	dir, err := os.MkdirTemp("", "driftmower-install-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	kubeconfig, err := d.installKubeconfig(raw, target.Name, key, dir)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, installTimeout)
	defer cancel()
	args := append(installArgs(kubeconfig, target.Name, target.Install.AuthMode), "--wait", "--timeout", "5m")
	cmd := exec.CommandContext(ctx, helm, args...)
	// Keep helm's own caches and registry login; isolate only Kubernetes access.
	cmd.Env = append(os.Environ(), "KUBECONFIG="+kubeconfig, "PATH="+pluginPath())
	output, err := cmd.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(strings.ReplaceAll(string(output), kubeconfig, "<kubeconfig>"))
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("helm install failed: %s", lastLine(message))
	}
	d.Retry(key)
	return nil
}

func (d *Dashboard) installDriftmower(w http.ResponseWriter, r *http.Request) {
	if !sameOriginLoopback(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var body struct {
		Key string `json:"key"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil || body.Key == "" {
		http.Error(w, "connection required", http.StatusBadRequest)
		return
	}
	// A page reload must not abort helm halfway; the desktop's lifetime bounds it.
	if err := d.discovery.Install(d.discovery.ctx, body.Key); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
