// Package config loads the server configuration from environment variables.
//
// An unset or empty variable takes the default. Values are validated here so a
// misconfigured server refuses to start instead of failing on first use.
package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/codemowers/driftmower/mcp/internal/cluster"
)

type Transport string

const (
	TransportStdio Transport = "stdio"
	TransportHTTP  Transport = "http"
)

type ScopeSource string

const (
	ScopeClaim ScopeSource = "claim"
	ScopeRBAC  ScopeSource = "rbac"
	ScopeUnion ScopeSource = "union"
)

type Config struct {
	ScannerURL        string
	ScannerTokenFile  string
	ScannerNamespace  string
	ScannerInstance   string
	CVEHistoryEnabled bool
	SAHistoryEnabled  bool
	Transport         Transport
	// Defaults to `::`, which serves IPv6 and IPv4 clients from one socket
	// wherever the OS leaves bindv6only off. Narrow it to `::1` or
	// `127.0.0.1` to bind loopback only.
	Host               string
	Port               int
	HealthPort         int
	LogLevel           string
	PublicURL          string
	DriftPrometheusURL string
	// Argo CD's public address, for links to the applications that track
	// workloads; Argo CD may run in another cluster.
	ArgoCDURL       string
	BrowserClientID string
	AllowedOrigins  []string
	// MCP sessions with no open request are closed after this long.
	SessionIdle time.Duration

	// Bearer verification on the HTTP transport. Ignored by stdio, which is a
	// local process with no network surface.
	AuthEnabled               bool
	AuthMode                  string
	OAuthClientID             string
	ServiceAccountAuthEnabled bool
	WorkloadRestartEnabled    bool
	// OIDCUser listing and effective-rights inspection for callers who may
	// impersonate users; needs impersonate on users and groups.
	UserAccess UserAccess
	// Present only when the HTTP transport runs with authentication; the
	// loader refuses to start an authenticated server without it.
	OIDC *OIDC

	Cluster       cluster.Identity
	Crawler       Crawler
	Registry      Crawler
	Search        Search
	Provisioning  Provisioning
	Kubernetes    Kubernetes
	Invalidate    Invalidate
	Tenancy       Tenancy
	Observability *Observability
}

type UserAccess struct {
	Enabled bool
	// Namespace holding Passmower OIDCUsers.
	Namespace string
	// Effective-rights evaluations are reused for this long.
	CacheTTL time.Duration
}

type OIDC struct {
	Issuer  string
	JWKSURI string
	// Empty means "use the resource this server advertises", which is what a
	// conformant client asks for.
	Audience        string
	NamespacesClaim string
	// Bearer token file for fetching the key set; empty fetches anonymously.
	JWKSBearerTokenFile string
	// Client IDs whose tokens this server accepts; empty accepts any client.
	AllowedClientIDs []string
}

// Crawler is driftmower-crawler, which serves version drift and advisory
// findings. An empty URL leaves the findings tools unregistered.
type Crawler struct {
	URL string
	// A projected ServiceAccount token for the crawler's audience, reread on
	// every request as the kubelet rotates it.
	TokenFile string
}

type Search struct {
	DefaultLimit int
	MaximumLimit int
}

type Provisioning struct {
	// Upper bound on namespaces one readiness call or capabilities request
	// fans out to.
	MaxNamespaces int
	// Fallback ingress domain when no admission guard publishes one; reported
	// as configured, not verified.
	IngressDomainSuffix string
	ClusterFactTTL      time.Duration
	TopologyTTL         time.Duration
	OperatorTTL         time.Duration
}

type Kubernetes struct {
	// A kubeconfig file to use instead of the in-cluster settings below, for
	// running outside the cluster during development. Its current context is
	// used.
	Kubeconfig string
	URL        string
	TokenFile  string
	CAFile     string
	// Mirror kube-apiserver's OIDC mapping: --oidc-username-claim,
	// --oidc-username-prefix, --oidc-groups-claim, --oidc-groups-prefix.
	UsernameClaim  string
	GroupsClaim    string
	UsernamePrefix string
	GroupsPrefix   string
	RequestTimeout time.Duration
	// Zero disables the SubjectAccessReview cache.
	SARCacheTTL time.Duration
	// Watch RBAC objects, namespaces and CRDs to invalidate caches on change.
	RBACWatchEnabled bool
}

type Invalidate struct {
	// Shared secret accepted on POST /api/cache/invalidate; empty disables it.
	SharedToken string
	// Kubernetes usernames whose ServiceAccount tokens, resolved by
	// TokenReview, may invalidate caches.
	AllowedSubjects []string
}

type Tenancy struct {
	// Which sources describe caller namespace scope: the token claim, the
	// cluster authorizer, or the union of both.
	ScopeSource ScopeSource
	// Upper bound on namespaces the RBAC scope sweep reviews for one caller.
	MaxNamespaces int
}

type Observability struct {
	PrometheusURL string
	// Prometheus's public address for links; empty uses its web.external-url.
	PrometheusExternalURL string
	LokiURL               string
	// Empty disables the alert tools.
	AlertmanagerURL string
	RequestTimeout  time.Duration
	// Evaluation and private browser cache windows; 0 disables alignment.
	Alignment time.Duration
}

// Load reads the configuration from the process environment.
func Load() (*Config, error) {
	return LoadFrom(os.LookupEnv)
}

// LoadFrom reads the configuration through lookup, which has the signature of
// os.LookupEnv.
func LoadFrom(lookup func(string) (string, bool)) (*Config, error) {
	r := &reader{lookup: lookup}
	c := r.load()
	if len(r.errs) > 0 {
		return nil, errors.Join(r.errs...)
	}

	return c, nil
}

// Kubernetes service links inject <SERVICE>_PORT=tcp://<ip>:<port> for every
// Service in the namespace. A Service named driftmower-mcp shadows
// DRIFTMOWER_MCP_PORT, and driftmower-mcp-health shadows
// DRIFTMOWER_MCP_HEALTH_PORT. A service-link URL is never a port number, so it
// is ignored and the default applies.
var serviceLinkValue = regexp.MustCompile(`^(tcp|udp|sctp)://`)

var shadowedByServiceLinks = map[string]bool{
	"DRIFTMOWER_MCP_PORT":        true,
	"DRIFTMOWER_MCP_HEALTH_PORT": true,
}

var clusterIDPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$`)

type reader struct {
	lookup func(string) (string, bool)
	errs   []error
}

func (r *reader) fail(format string, args ...any) {
	r.errs = append(r.errs, fmt.Errorf(format, args...))
}

// value returns the trimmed variable, or "" when it is unset or blank.
func (r *reader) value(name string) string {
	v, _ := r.lookup(name)
	v = strings.TrimSpace(v)
	if shadowedByServiceLinks[name] && serviceLinkValue.MatchString(v) {
		return ""
	}

	return v
}

func (r *reader) string(name, fallback string) string {
	if v := r.value(name); v != "" {
		return v
	}

	return fallback
}

func (r *reader) bool(name string, fallback bool) bool {
	switch strings.ToLower(r.value(name)) {
	case "":
		return fallback
	case "true":
		return true
	case "false":
		return false
	default:
		r.fail("%s must be true or false", name)

		return fallback
	}
}

// int reads an integer in [minimum, maximum]; maximum 0 means unbounded.
func (r *reader) int(name string, fallback, minimum, maximum int) int {
	v := r.value(name)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < minimum || (maximum > 0 && n > maximum) {
		if maximum > 0 {
			r.fail("%s must be an integer between %d and %d", name, minimum, maximum)
		} else {
			r.fail("%s must be an integer of at least %d", name, minimum)
		}

		return fallback
	}

	return n
}

func (r *reader) millis(name string, fallback time.Duration, minimum int) time.Duration {
	return time.Duration(r.int(name, int(fallback/time.Millisecond), minimum, 0)) * time.Millisecond
}

func (r *reader) enum(name, fallback string, allowed ...string) string {
	v := r.string(name, fallback)
	for _, a := range allowed {
		if v == a {
			return v
		}
	}
	r.fail("%s must be one of: %s", name, strings.Join(allowed, ", "))

	return fallback
}

// url reads an absolute HTTP(S) URL without credentials, query or fragment,
// with trailing slashes removed. It returns "" when unset and no fallback.
func (r *reader) url(name, fallback string, httpsOnly bool) string {
	v := r.string(name, fallback)
	if v == "" {
		return ""
	}
	parsed, err := url.Parse(v)
	if err != nil || !parsed.IsAbs() || parsed.Host == "" {
		r.fail("%s must be an absolute URL", name)

		return ""
	}
	if (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil ||
		parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
		r.fail("%s must use HTTP(S) without credentials, query strings or fragments", name)

		return ""
	}
	if httpsOnly && parsed.Scheme != "https" {
		r.fail("%s must use HTTPS", name)

		return ""
	}

	return strings.TrimRight(v, "/")
}

func (r *reader) list(name string) []string {
	var out []string
	for _, item := range strings.Split(r.value(name), ",") {
		if item = strings.TrimSpace(item); item != "" {
			out = append(out, item)
		}
	}

	return out
}

func (r *reader) load() *Config {
	c := &Config{
		Transport:   Transport(r.enum("DRIFTMOWER_MCP_TRANSPORT", "stdio", "stdio", "http")),
		Host:        r.string("DRIFTMOWER_MCP_HOST", "::"),
		Port:        r.int("DRIFTMOWER_MCP_PORT", 3000, 1, 65535),
		HealthPort:  r.int("DRIFTMOWER_MCP_HEALTH_PORT", 3001, 1, 65535),
		LogLevel:    r.enum("DRIFTMOWER_MCP_LOG_LEVEL", "info", "debug", "info", "warn", "error"),
		SessionIdle: r.millis("MCP_SESSION_IDLE_MS", 30*time.Minute, 1),
		AuthEnabled: r.bool("MCP_AUTH_ENABLED", true),
	}
	c.PublicURL = r.url("OIDC_CLIENT_ORIGIN", fmt.Sprintf("http://127.0.0.1:%d", c.Port), false)
	defaultAuthMode := "rbac"
	if !c.AuthEnabled {
		defaultAuthMode = "anonymous"
	}
	c.AuthMode = r.enum("MCP_AUTH_MODE", defaultAuthMode, "rbac", "oidc", "anonymous")
	c.AuthEnabled = c.AuthMode != "anonymous"
	c.OAuthClientID = r.value("OIDC_CLIENT_ID")

	c.Cluster = r.cluster(c.PublicURL)

	if c.Transport == TransportHTTP && c.AuthEnabled {
		c.OIDC = r.oidc()
	}
	authenticated := c.OIDC != nil

	c.ServiceAccountAuthEnabled = r.bool("MCP_SERVICE_ACCOUNT_AUTH_ENABLED", false)
	if c.ServiceAccountAuthEnabled && !authenticated {
		r.fail("MCP_SERVICE_ACCOUNT_AUTH_ENABLED requires authenticated HTTP")
	}
	c.WorkloadRestartEnabled = r.bool("MCP_WORKLOAD_RESTART_ENABLED", false)
	if c.AuthMode != "rbac" {
		c.WorkloadRestartEnabled = false
	}
	if c.WorkloadRestartEnabled && !authenticated {
		r.fail("MCP_WORKLOAD_RESTART_ENABLED requires authenticated HTTP and OIDC_IDP_URI")
	}
	c.UserAccess = UserAccess{
		Enabled:   r.bool("MCP_USER_ACCESS_ENABLED", false),
		Namespace: r.string("MCP_OIDC_USERS_NAMESPACE", "passmower"),
		CacheTTL:  r.millis("MCP_USER_ACCESS_CACHE_TTL_MS", 5*time.Minute, 0),
	}
	if c.UserAccess.Enabled && !authenticated && c.AuthMode != "anonymous" {
		r.fail("MCP_USER_ACCESS_ENABLED requires authenticated HTTP and OIDC_IDP_URI")
	}
	c.BrowserClientID = r.value("DASHBOARD_OIDC_CLIENT_ID")
	for _, origin := range append(strings.Split(r.value("MCP_ALLOWED_ORIGINS"), ","), r.value("DASHBOARD_OIDC_CLIENT_ORIGIN")) {
		origin = strings.TrimSpace(origin)
		if origin == "" {
			continue
		}
		u, err := url.Parse(origin)
		if err != nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"))) {
			r.fail("MCP_ALLOWED_ORIGINS and DASHBOARD_OIDC_CLIENT_ORIGIN must contain exact HTTPS origins or loopback HTTP origins")
			continue
		}
		c.AllowedOrigins = append(c.AllowedOrigins, origin)
	}
	c.ScannerURL = r.url("SCANNER_URL", "", false)
	c.ScannerTokenFile = r.string("SCANNER_TOKEN_FILE", "/var/run/secrets/driftmower/scanner/token")
	c.ScannerNamespace = r.value("POD_NAMESPACE")
	c.ScannerInstance = r.value("SCANNER_INSTANCE")
	c.CVEHistoryEnabled = r.bool("HISTORY_CVE_ENABLED", c.ScannerURL != "")
	c.SAHistoryEnabled = r.bool("HISTORY_SERVICE_ACCOUNTS_ENABLED", c.UserAccess.Enabled)
	c.DriftPrometheusURL = r.url("DRIFT_PROMETHEUS_URL", "", false)
	c.ArgoCDURL = r.url("ARGO_URL", "", false)

	c.Crawler = Crawler{
		URL:       r.url("CRAWLER_URL", "", false),
		TokenFile: r.string("CRAWLER_TOKEN_FILE", "/var/run/secrets/driftmower/crawler/token"),
	}
	c.Registry = Crawler{URL: r.url("REGISTRY_SCRAPER_URL", "", false), TokenFile: r.string("REGISTRY_SCRAPER_TOKEN_FILE", "/var/run/secrets/driftmower/registry/token")}

	if c.Crawler.URL != "" && c.Crawler.TokenFile == "" {
		r.fail("CRAWLER_TOKEN_FILE is required for the internal crawler API")
	}
	if c.Registry.URL != "" && c.Registry.TokenFile == "" {
		r.fail("REGISTRY_SCRAPER_TOKEN_FILE is required for the internal registry API")
	}

	c.Search.MaximumLimit = r.int("DRIFTMOWER_MCP_MAX_LIMIT", 100, 1, 0)
	c.Search.DefaultLimit = r.int("DRIFTMOWER_MCP_DEFAULT_LIMIT", 20, 1, c.Search.MaximumLimit)

	c.Provisioning = Provisioning{
		MaxNamespaces:       r.int("PROVISIONING_MAX_NAMESPACES", 20, 1, 200),
		IngressDomainSuffix: strings.TrimLeft(r.value("PROVISIONING_INGRESS_DOMAIN_SUFFIX"), "."),
		ClusterFactTTL:      r.millis("PROVISIONING_CLUSTER_FACT_TTL_MS", 5*time.Minute, 0),
		TopologyTTL:         r.millis("PROVISIONING_TOPOLOGY_TTL_MS", time.Minute, 0),
		OperatorTTL:         r.millis("PROVISIONING_OPERATOR_TTL_MS", 30*time.Second, 0),
	}

	c.Kubernetes = r.kubernetes(c.OIDC)

	c.Invalidate = Invalidate{
		SharedToken:     r.value("MCP_INVALIDATE_TOKEN"),
		AllowedSubjects: r.list("MCP_INVALIDATE_ALLOWED_SUBJECTS"),
	}

	c.Tenancy = Tenancy{
		ScopeSource:   ScopeSource(r.enum("MCP_SCOPE_SOURCE", "union", "claim", "rbac", "union")),
		MaxNamespaces: r.int("MCP_SCOPE_MAX_NAMESPACES", 2000, 1, 0),
	}

	c.Observability = r.observability(authenticated || c.Transport == TransportHTTP && c.AuthMode == "anonymous")
	if c.DriftPrometheusURL == "" && c.Observability != nil {
		c.DriftPrometheusURL = c.Observability.PrometheusURL
	}

	return c
}

func (r *reader) cluster(publicURL string) cluster.Identity {
	var id, apiURL *string
	if v := r.value("DRIFTMOWER_CLUSTER_ID"); v != "" {
		if clusterIDPattern.MatchString(v) {
			id = &v
		} else {
			r.fail("DRIFTMOWER_CLUSTER_ID must be a lowercase DNS-style cluster identifier, including the provider domain")
		}
	}
	if v := r.url("KUBERNETES_PUBLIC_API_URL", "", true); v != "" {
		apiURL = &v
	}

	return cluster.NewIdentity(id, apiURL, publicURL)
}

// Refusing to start beats starting open: an HTTP server published on an
// ingress with authentication on and no issuer would otherwise have to choose
// between serving unauthenticated and rejecting every call.
func (r *reader) oidc() *OIDC {
	issuer := r.value("OIDC_IDP_URI")
	if issuer == "" {
		r.fail("OIDC_IDP_URI is required when the HTTP transport runs with authentication " +
			"(set MCP_AUTH_ENABLED=false only for a server that is not reachable from outside the cluster)")

		return nil
	}

	return &OIDC{
		Issuer:              issuer,
		JWKSURI:             r.string("OIDC_JWKS_URI", strings.TrimRight(issuer, "/")+"/jwks"),
		Audience:            r.value("MCP_AUDIENCE"),
		NamespacesClaim:     r.string("MCP_NAMESPACES_CLAIM", "codemowers.io/namespaces"),
		JWKSBearerTokenFile: r.value("OIDC_JWKS_BEARER_TOKEN_FILE"),
		AllowedClientIDs:    r.list("MCP_ALLOWED_CLIENT_IDS"),
	}
}

func (r *reader) kubernetes(oidc *OIDC) Kubernetes {
	k := Kubernetes{
		Kubeconfig:       r.value("KUBECONFIG"),
		URL:              r.url("KUBERNETES_API_URL", "https://kubernetes.default.svc", true),
		TokenFile:        r.string("KUBERNETES_TOKEN_FILE", "/var/run/secrets/kubernetes.io/serviceaccount/token"),
		CAFile:           r.string("KUBERNETES_CA_FILE", "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"),
		UsernameClaim:    r.string("KUBERNETES_USERNAME_CLAIM", "sub"),
		GroupsClaim:      r.string("KUBERNETES_GROUPS_CLAIM", "groups"),
		GroupsPrefix:     r.value("KUBERNETES_GROUPS_PREFIX"),
		RequestTimeout:   r.millis("KUBERNETES_TIMEOUT_MS", 10*time.Second, 1),
		SARCacheTTL:      r.millis("MCP_SAR_CACHE_TTL_MS", time.Hour, 0),
		RBACWatchEnabled: r.bool("MCP_RBAC_WATCH_ENABLED", true),
	}
	// kube-apiserver's own default: `<issuer>#` unless the username claim is
	// `email`, which it leaves unprefixed. `-` disables the prefix explicitly.
	switch prefix := r.value("KUBERNETES_USERNAME_PREFIX"); {
	case prefix == "-":
	case prefix != "":
		k.UsernamePrefix = prefix
	case oidc != nil && k.UsernameClaim != "email":
		k.UsernamePrefix = oidc.Issuer + "#"
	}

	return k
}

func (r *reader) observability(authenticated bool) *Observability {
	prometheus := r.url("PROMETHEUS_URL", "", false)
	loki := r.url("LOKI_URL", "", false)
	alertmanager := r.url("ALERTMANAGER_URL", "", false)
	if prometheus == "" && loki == "" && alertmanager == "" && !r.bool("OBSERVABILITY_ENABLED", false) {
		return nil
	}
	if !authenticated {
		r.fail("observability tools require authenticated HTTP transport and OIDC_IDP_URI")
	}

	return &Observability{
		PrometheusURL:         prometheus,
		PrometheusExternalURL: r.url("PROMETHEUS_EXTERNAL_URL", "", false),
		LokiURL:               loki,
		AlertmanagerURL:       alertmanager,
		RequestTimeout:        r.millis("OBSERVABILITY_TIMEOUT_MS", 10*time.Second, 1),
		Alignment:             r.millis("OBSERVABILITY_ALIGNMENT_MS", 15*time.Second, 0),
	}
}
