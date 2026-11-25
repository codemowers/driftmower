package dashboard

import (
	"context"
	"errors"
	"net"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	discoveryv1 "k8s.io/api/discovery/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

type ClusterEndpoint struct {
	PortForward bool   `json:"portForward,omitempty"`
	Name        string `json:"name"`
	URL         string `json:"url"`
	ContextKey  string `json:"contextKey,omitempty"`
	AuthMethod  string `json:"authMethod,omitempty"`
}

type DiscoveredContext struct {
	ChromeProfile *ChromeProfile `json:"chromeProfile,omitempty"`
	PortForward   bool           `json:"portForward,omitempty"`
	Key           string         `json:"key"`
	APIServer     string         `json:"apiServer,omitempty"`
	AuthMethod    string         `json:"authMethod,omitempty"`
	Certificate   bool           `json:"certificate,omitempty"`
	Aliases       []ContextAlias `json:"aliases,omitempty"`
	Name          string         `json:"name"`
	Status        string         `json:"status"`
	// available; auth when the API server answers but credentials are
	// missing, expired or refused; unreachable; or other.
	State string `json:"state"`
	URL   string `json:"url,omitempty"`
	// Set when the API server answers but Driftmower is not installed.
	Install *InstallOffer `json:"install,omitempty"`
	// The context signs in with kubelogin and has no usable token; offered
	// only where this server may run kubelogin.
	// Offered also for AWS and Azure plugins, whose CLI login renews them.
	SignIn bool `json:"signIn,omitempty"`
	// The command Sign in runs for a cloud plugin, such as `az login …`.
	SignInCommand string `json:"signInCommand,omitempty"`
}

type ContextDiscovery struct {
	mu       sync.RWMutex
	contexts []DiscoveredContext
	path     string
	// Runs kubelogin when a person asks to sign in; discovery itself never
	// does, so it cannot open browsers unprompted.
	kubeLogin  bool
	signIns    signIns
	tokens     sync.Map // loginKey -> ID token from a sign-in
	wake       chan struct{}
	ctx        context.Context
	cancel     context.CancelFunc
	done       chan struct{}
	jumps      *sshJumps
	forwards   *desktopForwards
	chrome     *ChromeProfiles
	watchDone  chan struct{}
	updates    configUpdates
	generation atomic.Uint64
	installs   installs
}

func (d *ContextDiscovery) Snapshot() ([]DiscoveredContext, []ClusterEndpoint) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	contexts := append([]DiscoveredContext{}, d.contexts...)
	endpoints := []ClusterEndpoint{}
	seen := map[string]bool{}
	for _, c := range contexts {
		if c.Status == "available" && !seen[c.Key] {
			endpoints = append(endpoints, ClusterEndpoint{Name: c.Name, URL: c.URL, ContextKey: c.Key, AuthMethod: c.AuthMethod, PortForward: c.PortForward})
			seen[c.Key] = true
		}
	}
	return contexts, endpoints
}

func (d *ContextDiscovery) load() (*clientcmdapi.Config, error) {
	return d.loadingRules().Load()
}

func (d *ContextDiscovery) signedIn(key string) string {
	if token, ok := d.tokens.Load(key); ok {
		return token.(string)
	}

	return ""
}

// SignIn runs kubelogin for a context, then checks the contexts again.
func (d *ContextDiscovery) SignIn(ctx context.Context, name string) error {
	if !d.kubeLogin {
		return errors.New("signing in is available only in the desktop application")
	}
	raw, err := d.load()
	if err != nil {
		return errors.New("cannot read kubeconfig")
	}
	c := raw.Contexts[name]
	if c == nil {
		return errors.New("no such context")
	}
	auth := raw.AuthInfos[c.AuthInfo]
	if raw.Clusters[c.Cluster] == nil {
		return errors.New("invalid context configuration")
	}
	var connectionKey string
	for _, group := range contextGroups(raw) {
		for _, alias := range group.Aliases {
			if alias.Name == name {
				connectionKey = group.Key
			}
		}
	}
	if d.chrome != nil {
		if err := d.chrome.prepare(auth, raw.Clusters[c.Cluster].Server, connectionKey); err != nil {
			return err
		}
	}
	if name, args, ok := cloudLoginCommand(auth); ok {
		err := d.signIns.do(connectionKey+" "+name+" "+strings.Join(args, " "), func() error { return runCloudLogin(ctx, auth) })
		if err != nil {
			return err
		}
		select {
		case d.wake <- struct{}{}:
		default:
		}

		return nil
	}
	if !usesOIDCLogin(auth) {
		return errors.New("this context does not sign in with kubelogin")
	}
	key := loginKey(auth)
	err = d.signIns.do(key, func() error {
		token, err := runOIDCLogin(ctx, auth)
		if err == nil {
			d.tokens.Store(key, token)
		}

		return err
	})
	if err != nil {
		return err
	}
	select {
	case d.wake <- struct{}{}:
	default:
	}

	return nil
}

func (d *ContextDiscovery) refresh() {
	generation := d.generation.Load()
	raw, err := d.load()
	if err != nil {
		if d.forwards != nil {
			d.forwards.prune(nil)
		}
		if d.jumps != nil {
			d.jumps.prune(nil)
		}
		d.mu.Lock()
		if generation == d.generation.Load() {
			d.contexts = []DiscoveredContext{{Name: "kubeconfig", Status: "Cannot read kubeconfig"}}
		}
		d.mu.Unlock()
		d.notify()
		return
	}
	results, published := d.publishGroups(raw, generation)
	if !published {
		return
	}
	// Contexts often share an API server; each is dialled once.
	var reach sync.Map // server URL -> func() error
	reachable := func(server string) error {
		probe, _ := reach.LoadOrStore(server, sync.OnceValue(func() error { return dial(d.ctx, server) }))
		return probe.(func() error)()
	}
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for i, group := range results {
		wg.Add(1)
		go func(i int, group DiscoveredContext) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-d.ctx.Done():
				return
			}
			defer func() { <-sem }()
			if d.ctx.Err() != nil {
				return
			}
			result := d.inspectContext(raw, group.Name, group.Key, reachable)
			result.Key, result.APIServer, result.AuthMethod, result.Certificate, result.Aliases = group.Key, group.APIServer, group.AuthMethod, group.Certificate, group.Aliases
			result.ChromeProfile = group.ChromeProfile
			d.mu.Lock()
			if generation == d.generation.Load() {
				d.contexts[i] = result
			}
			d.mu.Unlock()
			d.notify()
		}(i, group)
	}
	wg.Wait()
	if generation != d.generation.Load() {
		return
	}
	if d.jumps != nil {
		keep := map[string]bool{}
		for _, entry := range raw.Contexts {
			cluster := raw.Clusters[entry.Cluster]
			if host, err := jumpHostForCluster(cluster); err == nil && host != "" {
				keep[sshJumpKey(host, cluster.Server)] = true
			}
		}
		d.jumps.prune(keep)
	}
	if d.forwards != nil {
		keep := map[string]bool{}
		d.mu.RLock()
		for _, result := range d.contexts {
			if result.PortForward {
				keep[forwardIdentityKey(result.Key, result.ChromeProfile)] = true
			}
		}
		d.mu.RUnlock()
		d.forwards.prune(keep)
	}
}

// dial reports whether the API server accepts connections at all.
func dial(ctx context.Context, server string) error {
	u, err := url.Parse(server)
	if err != nil || u.Host == "" {
		return errors.New("invalid server URL")
	}
	host := u.Host
	if u.Port() == "" {
		host = net.JoinHostPort(u.Hostname(), "443")
	}
	conn, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", host)
	if err != nil {
		return err
	}

	return conn.Close()
}

func (d *ContextDiscovery) inspectContext(raw *clientcmdapi.Config, name, key string, reachable func(server string) error) DiscoveredContext {
	result := DiscoveredContext{Name: name, State: "other"}
	raw = raw.DeepCopy()
	c := raw.Contexts[name]
	if c == nil {
		result.Status = "Invalid context configuration"
		return result
	}
	cluster := raw.Clusters[c.Cluster]
	if cluster == nil {
		result.Status = "Invalid context configuration"
		return result
	}
	jump, err := jumpHostForCluster(cluster)
	if err != nil {
		result.Status = err.Error()
		return result
	}
	var tunnel string
	if jump != "" {
		if d.jumps == nil {
			result.Status = "SSH jump hosts require the desktop application"
			return result
		}
		tunnel, err = d.jumps.address(jump, cluster.Server)
		if err != nil {
			result.Status = err.Error()
			result.State = "unreachable"
			return result
		}
		if err = reachable("http://" + tunnel); err != nil {
			result.Status = "SSH tunnel unreachable: " + err.Error()
			result.State = "unreachable"
			return result
		}
	} else if err = reachable(cluster.Server); err != nil {
		result.Status, result.State = "API server "+cluster.Server+" unreachable", "unreachable"
		return result
	}
	auth := raw.AuthInfos[c.AuthInfo]
	if d.chrome != nil {
		if err := d.chrome.prepare(auth, raw.Clusters[c.Cluster].Server, key); err != nil {
			result.Status = err.Error()
			return result
		}
	}
	var cloud bool
	if auth != nil {
		_, cloud = cloudPlugin(auth.Exec)
	}
	login, loginArgs, cloudLogin := cloudLoginCommand(auth)
	signIn := d.kubeLogin && (usesOIDCLogin(auth) || cloudLogin)
	if cloudLogin && d.kubeLogin {
		result.SignInCommand = strings.Join(append([]string{login}, loginArgs...), " ")
	}
	// Only the desktop application runs credential plugins.
	if cloud && !d.kubeLogin {
		result.Status, result.State, result.SignInCommand = ErrExecUnsupported.Error(), "auth", ""
		return result
	}
	if err := StaticCredentials(auth, time.Now(), d.signedIn); err != nil {
		result.Status, result.State = err.Error(), "auth"
		var session *ErrCloudSession
		switch {
		case errors.Is(err, ErrOIDCNotCached) && signIn:
			result.Status, result.SignIn = "Kubernetes sign-in required", true
		case errors.As(err, &session):
			result.Status, result.SignIn = "Sign-in needed: "+session.Message, signIn
		}
		return result
	}
	config, err := clientcmd.NewNonInteractiveClientConfig(*raw, name, &clientcmd.ConfigOverrides{}, nil).ClientConfig()
	if err != nil {
		result.Status = "Invalid context configuration"
		return result
	}
	if tunnel != "" {
		if err := configureSSHJump(config, tunnel); err != nil {
			result.Status = err.Error()
			return result
		}
	}
	config.Timeout = 15 * time.Second
	client, err := kubernetes.NewForConfig(config)
	if err != nil {
		result.Status = "Invalid Kubernetes client configuration"
		return result
	}
	ctx, cancel := context.WithTimeout(d.ctx, 15*time.Second)
	defer cancel()
	service, err := client.CoreV1().Services("driftmower").Get(ctx, "mcp", metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		service, err = client.CoreV1().Services("driftmower").Get(ctx, "driftmower-mcp", metav1.GetOptions{})
	}
	if err != nil {
		switch {
		case apierrors.IsNotFound(err):
			result.Status = "Driftmower is not installed on this cluster: no MCP Service in the driftmower namespace"
			result.Install = d.installOffer(ctx, client, name, tunnel != "")
		case apierrors.IsForbidden(err):
			result.Status = "Service discovery forbidden"
		case apierrors.IsUnauthorized(err):
			result.Status, result.State, result.SignIn = "Kubernetes sign-in required", "auth", signIn
		case strings.Contains(err.Error(), "getting credentials"):
			// The credential plugin failed, typically an expired cloud CLI
			// session.
			result.Status, result.State, result.SignIn = "Credentials need refreshing: "+err.Error(), "auth", signIn
		default:
			result.Status = "Kubernetes API request failed: " + err.Error()
		}
		return result
	}
	slices, e := client.DiscoveryV1().EndpointSlices("driftmower").List(ctx, metav1.ListOptions{LabelSelector: "kubernetes.io/service-name=" + service.Name})
	notReady := e == nil && !anyReady(slices.Items)
	endpoint := service.Annotations["driftmower.io/mcp-url"]
	if endpoint == "" {
		ingresses, e := client.NetworkingV1().Ingresses("driftmower").List(ctx, metav1.ListOptions{})
		if e != nil && d.forwards == nil {
			result.Status = "MCP installed; ingress discovery unavailable"
			return result
		}
		if ingresses != nil {
			for _, ingress := range ingresses.Items {
				for _, rule := range ingress.Spec.Rules {
					// A single-label host such as "mcp" relies on cluster
					// admission expanding it; unexpanded, nothing outside the
					// cluster resolves it, so the desktop forwards instead.
					if rule.HTTP == nil || !strings.Contains(rule.Host, ".") {
						continue
					}
					for _, path := range rule.HTTP.Paths {
						if path.Backend.Service != nil && path.Backend.Service.Name == service.Name {
							endpoint = "https://" + rule.Host + "/mcp"
							break
						}
					}
					if endpoint != "" {
						break
					}
				}
				if endpoint != "" {
					break
				}
			}
		}
	}
	if endpoint == "" && d.forwards != nil {
		// Retain the local port reservation across a rollout with no Ready
		// endpoint, so the browser can reconnect to the same transport URL.
		result.PortForward = true
		if notReady {
			result.Status = "MCP installed but not running"
			return result
		}
		profile, _ := profileForAuth(auth)
		endpoint, err = d.forwards.service(ctx, forwardIdentityKey(key, &profile), config, client, service)
		if err != nil {
			result.Status = "MCP port-forward unavailable: " + err.Error()
			return result
		}
		result.Status, result.State, result.URL, result.PortForward = "available", "available", endpoint, true
		return result
	}
	if notReady {
		result.Status = "MCP installed but not running"
		return result
	}
	if endpoint == "" {
		result.Status = "MCP installed; no public endpoint advertised"
		return result
	}
	parsed, e := url.Parse(endpoint)
	if e != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		result.Status = "MCP installed; invalid public endpoint"
		return result
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	if !strings.HasSuffix(parsed.Path, "/mcp") {
		parsed.Path += "/mcp"
	}
	result.Status, result.State = "available", "available"
	result.URL = parsed.String()
	return result
}

func anyReady(slices []discoveryv1.EndpointSlice) bool {
	for _, slice := range slices {
		for _, endpoint := range slice.Endpoints {
			if endpoint.Conditions.Ready == nil || *endpoint.Conditions.Ready {
				return true
			}
		}
	}
	return false
}

// StartDiscovery reacts to kubeconfig writes, sign-in, retries and tunnel
// lifecycle events. It never polls files or probes clusters on a timer.
func StartDiscovery(enabled bool, path string, kubeLogin bool, chrome ...*ChromeProfiles) *ContextDiscovery {
	ctx, cancel := context.WithCancel(context.Background())
	d := &ContextDiscovery{path: path, kubeLogin: kubeLogin, wake: make(chan struct{}, 1), ctx: ctx, cancel: cancel, done: make(chan struct{}), watchDone: make(chan struct{})}
	if len(chrome) > 0 {
		d.chrome = chrome[0]
	}
	if kubeLogin {
		d.forwards = newDesktopForwards(ctx, d.wake)
		d.jumps = newSSHJumps(ctx)
	}
	if enabled {
		d.startKubeconfigWatcher()
		go func() {
			defer close(d.done)
			for {
				if ctx.Err() != nil {
					return
				}
				d.refresh()
				select {
				case <-ctx.Done():
					return
				case <-d.wake:
				}
			}
		}()
	} else {
		close(d.done)
		close(d.watchDone)
	}
	return d
}

func (d *ContextDiscovery) Close() {
	d.cancel()
	if d.jumps != nil {
		d.jumps.Close()
	}
	if d.forwards != nil {
		d.forwards.Close()
	}
	<-d.done
	<-d.watchDone
}
