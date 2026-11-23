package config

import (
	"maps"
	"strings"
	"testing"
	"time"
)

func env(values map[string]string) func(string) (string, bool) {
	return func(name string) (string, bool) {
		v, ok := values[name]

		return v, ok
	}
}

func load(t *testing.T, values map[string]string) *Config {
	t.Helper()
	c, err := LoadFrom(env(values))
	if err != nil {
		t.Fatalf("LoadFrom: %v", err)
	}

	return c
}

func loadError(t *testing.T, values map[string]string) string {
	t.Helper()
	_, err := LoadFrom(env(values))
	if err == nil {
		t.Fatal("LoadFrom succeeded, want error")
	}

	return err.Error()
}

var noBackend = map[string]string{}

func with(base map[string]string, extra map[string]string) map[string]string {
	out := maps.Clone(base)
	maps.Copy(out, extra)

	return out
}

var authenticatedHTTP = with(noBackend, map[string]string{
	"DRIFTMOWER_MCP_TRANSPORT": "http",
	"OIDC_IDP_URI":             "https://auth.example.com/",
})

func TestDefaults(t *testing.T) {
	c := load(t, map[string]string{})

	if c.Transport != TransportStdio || c.Host != "::" || c.Port != 3000 || c.HealthPort != 3001 {
		t.Errorf("server defaults = %v %q %d %d", c.Transport, c.Host, c.Port, c.HealthPort)
	}
	if c.PublicURL != "http://127.0.0.1:3000" {
		t.Errorf("PublicURL = %q", c.PublicURL)
	}
	if c.SessionIdle != 30*time.Minute {
		t.Errorf("SessionIdle = %v", c.SessionIdle)
	}
	if c.OIDC != nil || c.Observability != nil {
		t.Errorf("stdio must not load OIDC or observability")
	}
	if c.Crawler != (Crawler{TokenFile: "/var/run/secrets/driftmower/crawler/token"}) {
		t.Errorf("Crawler = %+v", c.Crawler)
	}
	if c.Search != (Search{DefaultLimit: 20, MaximumLimit: 100}) {
		t.Errorf("Search = %+v", c.Search)
	}
	if c.Kubernetes.SARCacheTTL != time.Hour || !c.Kubernetes.RBACWatchEnabled || c.Kubernetes.UsernamePrefix != "" {
		t.Errorf("Kubernetes = %+v", c.Kubernetes)
	}
	if c.Tenancy != (Tenancy{ScopeSource: ScopeUnion, MaxNamespaces: 2000}) {
		t.Errorf("Tenancy = %+v", c.Tenancy)
	}
	if c.Cluster.MCPServerName != "driftmower-127-0-0-1-3000" {
		t.Errorf("MCPServerName = %q", c.Cluster.MCPServerName)
	}
}

func TestAccessModes(t *testing.T) {
	for _, mode := range []string{"rbac", "oidc", "anonymous"} {
		values := with(authenticatedHTTP, map[string]string{"MCP_AUTH_MODE": mode, "PROMETHEUS_URL": "http://prometheus:9090", "MCP_WORKLOAD_RESTART_ENABLED": "true"})
		if mode == "anonymous" {
			delete(values, "OIDC_IDP_URI")
		}
		c := load(t, values)
		if c.AuthMode != mode || (c.OIDC == nil) != (mode == "anonymous") || c.WorkloadRestartEnabled != (mode == "rbac") || c.Observability == nil {
			t.Fatalf("mode %s: %+v", mode, c)
		}
	}
	if !strings.Contains(loadError(t, with(authenticatedHTTP, map[string]string{"MCP_AUTH_MODE": "typo"})), "MCP_AUTH_MODE") {
		t.Fatal("invalid access mode accepted")
	}
}

func TestEmptyValuesMeanUnset(t *testing.T) {
	c := load(t, with(noBackend, map[string]string{"MCP_AUDIENCE": "", "DRIFTMOWER_MCP_PORT": "  "}))
	if c.Port != 3000 {
		t.Errorf("Port = %d", c.Port)
	}
}

func TestServiceLinkValuesAreIgnored(t *testing.T) {
	c := load(t, with(noBackend, map[string]string{
		"DRIFTMOWER_MCP_PORT":        "tcp://10.0.0.1:3000",
		"DRIFTMOWER_MCP_HEALTH_PORT": "udp://10.0.0.1:3001",
	}))
	if c.Port != 3000 || c.HealthPort != 3001 {
		t.Errorf("ports = %d %d", c.Port, c.HealthPort)
	}
}

func TestAuthenticatedHTTPRequiresIssuer(t *testing.T) {
	msg := loadError(t, with(noBackend, map[string]string{"DRIFTMOWER_MCP_TRANSPORT": "http"}))
	if !strings.Contains(msg, "OIDC_IDP_URI is required") {
		t.Errorf("error = %q", msg)
	}

	c := load(t, with(noBackend, map[string]string{"DRIFTMOWER_MCP_TRANSPORT": "http", "MCP_AUTH_ENABLED": "false"}))
	if c.OIDC != nil {
		t.Error("OIDC loaded with authentication off")
	}
}

func TestOIDCDefaults(t *testing.T) {
	c := load(t, with(authenticatedHTTP, map[string]string{"MCP_ALLOWED_CLIENT_IDS": " a, ,b "}))

	if c.OIDC.JWKSURI != "https://auth.example.com/jwks" {
		t.Errorf("JWKSURI = %q", c.OIDC.JWKSURI)
	}
	if c.OIDC.NamespacesClaim != "codemowers.io/namespaces" {
		t.Errorf("NamespacesClaim = %q", c.OIDC.NamespacesClaim)
	}
	if strings.Join(c.OIDC.AllowedClientIDs, "|") != "a|b" {
		t.Errorf("AllowedClientIDs = %q", c.OIDC.AllowedClientIDs)
	}
}

func TestUsernamePrefix(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want string
	}{
		{"issuer default", authenticatedHTTP, "https://auth.example.com/#"},
		{"email claim unprefixed", with(authenticatedHTTP, map[string]string{"KUBERNETES_USERNAME_CLAIM": "email"}), ""},
		{"dash disables", with(authenticatedHTTP, map[string]string{"KUBERNETES_USERNAME_PREFIX": "-"}), ""},
		{"explicit", with(authenticatedHTTP, map[string]string{"KUBERNETES_USERNAME_PREFIX": "oidc:"}), "oidc:"},
		{"no OIDC", noBackend, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := load(t, tc.env).Kubernetes.UsernamePrefix; got != tc.want {
				t.Errorf("UsernamePrefix = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestFeaturesRequireAuthentication(t *testing.T) {
	for _, name := range []string{
		"MCP_SERVICE_ACCOUNT_AUTH_ENABLED",
		"MCP_WORKLOAD_RESTART_ENABLED",
		"OBSERVABILITY_ENABLED",
	} {
		t.Run(name, func(t *testing.T) {
			loadError(t, with(noBackend, map[string]string{name: "true"}))
		})
	}

	loadError(t, with(noBackend, map[string]string{"PROMETHEUS_URL": "http://prometheus:9090"}))
}

func TestObservability(t *testing.T) {
	c := load(t, with(authenticatedHTTP, map[string]string{"PROMETHEUS_URL": "http://prometheus:9090/"}))
	if c.Observability == nil || c.Observability.PrometheusURL != "http://prometheus:9090" {
		t.Fatalf("Observability = %+v", c.Observability)
	}
	if c.Observability.Alignment != 15*time.Second {
		t.Errorf("guards = %+v", c.Observability)
	}
}

func TestStrictBooleans(t *testing.T) {
	msg := loadError(t, with(noBackend, map[string]string{"MCP_RBAC_WATCH_ENABLED": "yes"}))
	if !strings.Contains(msg, "MCP_RBAC_WATCH_ENABLED must be true or false") {
		t.Errorf("error = %q", msg)
	}
	if c := load(t, with(noBackend, map[string]string{"MCP_RBAC_WATCH_ENABLED": "FALSE"})); c.Kubernetes.RBACWatchEnabled {
		t.Error("FALSE parsed as true")
	}
}

func TestURLValidation(t *testing.T) {
	cases := map[string]string{
		"OIDC_CLIENT_ORIGIN":        "https://user:pw@mcp.example.com",
		"KUBERNETES_API_URL":        "http://kubernetes.default.svc",
		"KUBERNETES_PUBLIC_API_URL": "http://kube.example.com",
	}
	for name, value := range cases {
		t.Run(name, func(t *testing.T) {
			if msg := loadError(t, with(noBackend, map[string]string{name: value})); !strings.Contains(msg, name) {
				t.Errorf("error = %q", msg)
			}
		})
	}
}

func TestLimits(t *testing.T) {
	loadError(t, with(noBackend, map[string]string{"DRIFTMOWER_MCP_DEFAULT_LIMIT": "101"}))
	loadError(t, with(noBackend, map[string]string{"PROVISIONING_MAX_NAMESPACES": "201"}))
	loadError(t, with(noBackend, map[string]string{"DRIFTMOWER_MCP_PORT": "0"}))
	loadError(t, with(noBackend, map[string]string{"MCP_SAR_CACHE_TTL_MS": "-1"}))

	if c := load(t, with(noBackend, map[string]string{"MCP_SAR_CACHE_TTL_MS": "0"})); c.Kubernetes.SARCacheTTL != 0 {
		t.Errorf("SARCacheTTL = %v", c.Kubernetes.SARCacheTTL)
	}
}

func TestClusterIdentity(t *testing.T) {
	c := load(t, with(noBackend, map[string]string{
		"DRIFTMOWER_CLUSTER_ID":     "bravo.codemowers.cloud",
		"KUBERNETES_PUBLIC_API_URL": "https://kube.bravo.codemowers.cloud/",
	}))
	if *c.Cluster.ID != "bravo.codemowers.cloud" || *c.Cluster.APIURL != "https://kube.bravo.codemowers.cloud" {
		t.Errorf("Cluster = %+v", c.Cluster)
	}
	if c.Cluster.MCPServerName != "driftmower-bravo-codemowers-cloud" {
		t.Errorf("MCPServerName = %q", c.Cluster.MCPServerName)
	}

	loadError(t, with(noBackend, map[string]string{"DRIFTMOWER_CLUSTER_ID": "Bravo"}))
}

func TestMisc(t *testing.T) {
	c := load(t, with(noBackend, map[string]string{
		"PROVISIONING_INGRESS_DOMAIN_SUFFIX": "..apps.example.com",
		"MCP_INVALIDATE_ALLOWED_SUBJECTS":    "system:serviceaccount:argocd:argocd-server, ",
		"MCP_SCOPE_SOURCE":                   "claim",
	}))
	if c.Provisioning.IngressDomainSuffix != "apps.example.com" {
		t.Errorf("IngressDomainSuffix = %q", c.Provisioning.IngressDomainSuffix)
	}
	if len(c.Invalidate.AllowedSubjects) != 1 {
		t.Errorf("AllowedSubjects = %q", c.Invalidate.AllowedSubjects)
	}
	if c.Tenancy.ScopeSource != ScopeClaim {
		t.Errorf("ScopeSource = %q", c.Tenancy.ScopeSource)
	}

	loadError(t, with(noBackend, map[string]string{"MCP_SCOPE_SOURCE": "token"}))
}

func TestErrorsAreJoined(t *testing.T) {
	msg := loadError(t, map[string]string{"DRIFTMOWER_MCP_PORT": "x", "DRIFTMOWER_MCP_LOG_LEVEL": "trace"})
	for _, want := range []string{"DRIFTMOWER_MCP_PORT", "DRIFTMOWER_MCP_LOG_LEVEL"} {
		if !strings.Contains(msg, want) {
			t.Errorf("error %q lacks %s", msg, want)
		}
	}
}

func TestCrawler(t *testing.T) {
	c := load(t, with(noBackend, map[string]string{"CRAWLER_URL": "http://driftmower-crawler:8080", "CRAWLER_TOKEN_FILE": "/token"}))
	if c.Crawler != (Crawler{URL: "http://driftmower-crawler:8080", TokenFile: "/token"}) {
		t.Errorf("Crawler = %+v", c.Crawler)
	}
	if msg := loadError(t, with(noBackend, map[string]string{"CRAWLER_URL": "driftmower-crawler"})); !strings.Contains(msg, "CRAWLER_URL") {
		t.Errorf("error = %q", msg)
	}
}

func TestTechnicalDebtEnvironment(t *testing.T) {
	defaults := load(t, noBackend)
	if defaults.HoursPerUpgrade != 1 || defaults.BuildAgeDaysPerUpgrade != 365 {
		t.Fatalf("defaults %+v", defaults)
	}
	configured := load(t, map[string]string{"TECHNICAL_DEBT_HOURS_PER_UPGRADE": "2.5", "TECHNICAL_DEBT_BUILD_AGE_DAYS_PER_UPGRADE": "180"})
	if configured.HoursPerUpgrade != 2.5 || configured.BuildAgeDaysPerUpgrade != 180 {
		t.Fatalf("configured %+v", configured)
	}
	for _, name := range []string{"TECHNICAL_DEBT_HOURS_PER_UPGRADE", "TECHNICAL_DEBT_BUILD_AGE_DAYS_PER_UPGRADE"} {
		for _, value := range []string{"0", "-1", "NaN", "Inf", "oops", "100000"} {
			if !strings.Contains(loadError(t, map[string]string{name: value}), name) {
				t.Fatalf("missing error for %s=%s", name, value)
			}
		}
	}
}
