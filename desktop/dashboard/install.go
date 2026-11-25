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
	"slices"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

const (
	installChart     = "oci://ghcr.io/codemowers/charts/driftmower"
	installRelease   = "driftmower"
	installNamespace = "driftmower"
	// Up to three helm installs (cert-manager, trust-manager, Driftmower).
	installTimeout = 20 * time.Minute
	passmowerGroup = "codemowers.cloud/v1"
)

// InstallOffer describes how Driftmower could be added to a cluster that has
// no MCP. Settings always shows the command; one-click install additionally
// needs a known auth mode and a local helm binary.
type InstallOffer struct {
	// rbac when the cluster has Passmower's OIDCClient API; anonymous when it
	// confirmedly has not; empty when that could not be determined.
	AuthMode string `json:"authMode,omitempty"`
	// The cluster's admission expands short Ingress hosts such as "mcp" into
	// resolvable names, which the chart's default Ingresses rely on.
	HostExpansion bool `json:"hostExpansion,omitempty"`
	// Whether admission gives Pods a CA bundle: injected, missing, or empty
	// when the dry-run check could not tell.
	TrustedCA string `json:"trustedCA,omitempty"`
	// Set for OIDC installs where Pods get no CA bundle: the CA trust layer
	// one-click install adds first, since every login would fail without it.
	Trust *TrustSetup `json:"trust,omitempty"`
	// StorageClasses the operator and registry scraper claims could use, and
	// the cluster default among them; without a default the person chooses.
	StorageClasses      []string `json:"storageClasses,omitempty"`
	DefaultStorageClass string   `json:"defaultStorageClass,omitempty"`
	// Copyable helm command using the person's kubeconfig context.
	Command string `json:"command"`
	// Local helm executable is available for one-click install.
	Helm bool `json:"helm,omitempty"`
	// The context reaches its API server through a desktop SSH jump host,
	// which the copyable command cannot use outside the desktop.
	SSHJump bool `json:"sshJump,omitempty"`
}

// installValues are the Helm values one-click install sets. With Passmower the
// chart defaults apply where admission expands their short Ingress hosts;
// otherwise those Ingresses would advertise unresolvable names, so MCP is
// reached by port-forward with its canonical OIDC audience and the desktop
// serves the dashboard. Without Passmower, MCP runs anonymously behind a Service only,
// and its NetworkPolicy leaves Kubernetes port-forwarding (and so
// pods/portforward RBAC) as the only way in; components needing other
// platform APIs stay off, as in the deployment guide's minimal profile.
type installSettings struct {
	authMode      string
	hostExpansion bool
	// Empty uses the cluster default StorageClass.
	storageClass string
	// Mount the trusted-ca-certs bundle from the CA trust layer.
	trustBundle bool
	// Chart reference; empty is the published chart.
	chart string
	// Further values, such as release image references for a local chart.
	extra []string
}

func installValues(settings installSettings) []string {
	authMode, hostExpansion := settings.authMode, settings.hostExpansion
	values := []string{"mcp.dashboard.localOrigins={" + DesktopOrigin + "}"}
	if settings.trustBundle {
		values = append(values, "trustedCA.configMapName="+trustBundleName)
	}
	if authMode == "rbac" && settings.storageClass != "" {
		values = append(values, "operator.sbomStorageClassName="+settings.storageClass, "registryScraper.storageClassName="+settings.storageClass)
	}
	if authMode == "rbac" && !hostExpansion {
		values = append(values, "mcp.ingress.enabled=false", "ui.enabled=false")
	}
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
	values = append(values, settings.extra...)
	return values
}

func installArgs(kubeconfig, context, version string, settings installSettings) []string {
	chart := settings.chart
	if chart == "" {
		chart = installChart
	}
	args := []string{"upgrade", "--install", installRelease, chart}
	if version != "" {
		args = append(args, "--version", version)
	}
	if kubeconfig != "" {
		args = append(args, "--kubeconfig", kubeconfig)
	}
	args = append(args, "--kube-context", context, "--namespace", installNamespace, "--create-namespace")
	for _, value := range installValues(settings) {
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

func installCommand(context string, settings installSettings) string {
	return "helm " + strings.Join(quoteAll(installArgs("", context, "", settings)), " ")
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
	if mode == "rbac" {
		offer.HostExpansion = expandsShortHosts(ctx, client)
	}
	offer.TrustedCA = trustedCAInjection(ctx, client)
	settings := installSettings{authMode: mode, hostExpansion: offer.HostExpansion}
	if offer.AuthMode == "rbac" && offer.TrustedCA == "missing" {
		offer.Trust = trustSetup(ctx, client, context)
		settings.trustBundle = true
	}
	if mode == "rbac" {
		offer.StorageClasses, offer.DefaultStorageClass = storageClasses(ctx, client)
		if offer.DefaultStorageClass == "" {
			settings.storageClass = "<storage-class>"
		}
	}
	offer.Command = installCommand(context, settings)
	if d.kubeLogin {
		_, err := lookPath("helm", pluginPath())
		offer.Helm = err == nil && offer.AuthMode != ""
	}
	return offer
}

// expandsShortHosts asks admission, through a server-side dry run that
// persists nothing, what becomes of an Ingress host "mcp". Any failure,
// including missing permission, counts as no expansion: port-forwarding works
// either way.
func expandsShortHosts(ctx context.Context, client kubernetes.Interface) bool {
	ingress := &networkingv1.Ingress{
		ObjectMeta: metav1.ObjectMeta{Name: "driftmower-host-check"},
		Spec:       networkingv1.IngressSpec{Rules: []networkingv1.IngressRule{{Host: "mcp"}}},
	}
	for _, namespace := range probeNamespaces(ctx, client) {
		created, err := client.NetworkingV1().Ingresses(namespace).Create(ctx, ingress, metav1.CreateOptions{DryRun: []string{metav1.DryRunAll}})
		if err == nil {
			return len(created.Spec.Rules) > 0 && strings.Contains(created.Spec.Rules[0].Host, ".")
		}
	}
	return false
}

// probeNamespaces lists where dry-run admission probes may run: the release
// namespace when it exists, default, then a few ordinary namespaces, because
// platforms may block the default namespace and exempt kube-* namespaces
// from workload policies. Probes use fixed names because admission policies
// may read metadata.name, which generateName leaves empty at that point.
func probeNamespaces(ctx context.Context, client kubernetes.Interface) []string {
	out := []string{installNamespace, metav1.NamespaceDefault}
	list, err := client.CoreV1().Namespaces().List(ctx, metav1.ListOptions{Limit: 50})
	if err != nil {
		return out
	}
	for _, namespace := range list.Items {
		if len(out) >= 5 {
			break
		}
		name := namespace.Name
		if name == installNamespace || name == metav1.NamespaceDefault || strings.HasPrefix(name, "kube-") || strings.HasSuffix(name, "-system") {
			continue
		}
		out = append(out, name)
	}
	return out
}

// trustedCAInjection asks admission, through a server-side dry run, whether a
// new Pod receives a CA bundle the way the codemowers platform's
// workload-trusted-ca policy provides one. The probe Pod meets the restricted
// Pod Security profile so that policy does not reject it first.
func trustedCAInjection(ctx context.Context, client kubernetes.Interface) string {
	yes, no, user := true, false, int64(65535)
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "driftmower-ca-check"},
		Spec: corev1.PodSpec{
			SecurityContext: &corev1.PodSecurityContext{RunAsNonRoot: &yes, RunAsUser: &user, SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault}},
			Containers: []corev1.Container{{
				Name:            "check",
				Image:           "registry.k8s.io/pause:3.10",
				SecurityContext: &corev1.SecurityContext{AllowPrivilegeEscalation: &no, Capabilities: &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}}},
			}},
		},
	}
	var created *corev1.Pod
	for _, namespace := range probeNamespaces(ctx, client) {
		if result, err := client.CoreV1().Pods(namespace).Create(ctx, pod, metav1.CreateOptions{DryRun: []string{metav1.DryRunAll}}); err == nil {
			created = result
			break
		}
	}
	if created == nil || len(created.Spec.Containers) == 0 {
		return ""
	}
	container := created.Spec.Containers[0]
	for _, env := range container.Env {
		if env.Name == "SSL_CERT_FILE" {
			return "injected"
		}
	}
	for _, mount := range container.VolumeMounts {
		if strings.HasPrefix(mount.MountPath, "/etc/ssl/certs") {
			return "injected"
		}
	}
	return "missing"
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
// InstallOptions are the person's choices in the confirmation dialog.
type InstallOptions struct {
	// Required for the operator and registry scraper claims when the cluster
	// has no default StorageClass.
	StorageClass string `json:"storageClass"`
	// Consent to install cert-manager when the CA trust layer needs it.
	InstallCertManager bool `json:"installCertManager"`
}

func (d *ContextDiscovery) Install(ctx context.Context, key string, options InstallOptions) error {
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
	trust := target.Install.Trust
	if trust != nil && !trust.CertManager && !options.InstallCertManager {
		return errors.New("this cluster gives Pods no CA certificates; setting up trust-manager needs cert-manager, which must be installed too")
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
	settings := installSettings{authMode: target.Install.AuthMode, hostExpansion: target.Install.HostExpansion, trustBundle: trust != nil}
	if settings.authMode == "rbac" && target.Install.DefaultStorageClass == "" {
		if !slices.Contains(target.Install.StorageClasses, options.StorageClass) {
			return errors.New("this cluster has no default StorageClass; choose one for the operator and registry scraper volumes")
		}
		settings.storageClass = options.StorageClass
	}
	// Check the chart before changing anything, including the trust layer:
	// helm silently ignores values a chart does not define, which would
	// install a broken Driftmower.
	if local := localInstallChart(); local != "" {
		images, err := releaseImages(ctx, helm)
		if err != nil {
			return err
		}
		settings.chart, settings.extra = local, images
	}
	version, err := checkChart(ctx, helm, settings.chart, installValues(settings))
	if err != nil {
		return err
	}
	if trust != nil {
		if !trust.CertManager {
			if err := runHelm(ctx, helm, kubeconfig, "cert-manager", certManagerArgs(kubeconfig, target.Name)); err != nil {
				return err
			}
		}
		if !trust.TrustManager {
			if err := runHelm(ctx, helm, kubeconfig, "trust-manager", trustManagerArgs(kubeconfig, target.Name)); err != nil {
				return err
			}
		}
		if !trust.Bundle {
			if err := createTrustBundle(ctx, kubeconfig); err != nil {
				return fmt.Errorf("create Bundle %s: %w", trustBundleName, err)
			}
		}
	}
	if err := runHelm(ctx, helm, kubeconfig, "Driftmower", installArgs(kubeconfig, target.Name, version, settings)); err != nil {
		return err
	}
	d.Retry(key)
	return nil
}

func runHelm(ctx context.Context, helm, kubeconfig, what string, args []string) error {
	cmd := exec.CommandContext(ctx, helm, append(args, "--wait", "--timeout", "5m")...)
	// Keep helm's own caches and registry login; isolate only Kubernetes access.
	cmd.Env = append(os.Environ(), "KUBECONFIG="+kubeconfig, "PATH="+pluginPath())
	output, err := cmd.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(strings.ReplaceAll(string(output), kubeconfig, "<kubeconfig>"))
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("helm install of %s failed: %s", what, lastLine(message))
	}
	return nil
}

func (d *Dashboard) installDriftmower(w http.ResponseWriter, r *http.Request) {
	if !sameOriginLoopback(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var body struct {
		Key string `json:"key"`
		InstallOptions
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil || body.Key == "" {
		http.Error(w, "connection required", http.StatusBadRequest)
		return
	}
	// A page reload must not abort helm halfway; the desktop's lifetime bounds it.
	if err := d.discovery.Install(d.discovery.ctx, body.Key, body.InstallOptions); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
