// Command driftmower-mcp exposes a Kubernetes cluster through the Model
// Context Protocol.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"golang.org/x/sync/errgroup"
	authorizationv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes"

	"github.com/codemowers/driftmower/internal/platformapis"
	"github.com/codemowers/driftmower/internal/registry"
	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/catalog"
	"github.com/codemowers/driftmower/mcp/internal/cluster"
	"github.com/codemowers/driftmower/mcp/internal/config"
	"github.com/codemowers/driftmower/mcp/internal/drifthistory"
	"github.com/codemowers/driftmower/mcp/internal/findings"
	"github.com/codemowers/driftmower/mcp/internal/httpserver"
	"github.com/codemowers/driftmower/mcp/internal/kube"
	"github.com/codemowers/driftmower/mcp/internal/logging"
	"github.com/codemowers/driftmower/mcp/internal/mcpserver"
	"github.com/codemowers/driftmower/mcp/internal/metrics"
	"github.com/codemowers/driftmower/mcp/internal/observability"
	"github.com/codemowers/driftmower/mcp/internal/provisioning/facts"
	"github.com/codemowers/driftmower/mcp/internal/provisioning/service"
	"github.com/codemowers/driftmower/mcp/internal/securitymetrics"
	"github.com/codemowers/driftmower/mcp/internal/ttlcache"
	"github.com/codemowers/driftmower/mcp/internal/useraccess"
	"github.com/codemowers/driftmower/mcp/internal/workloads"
)

// version is set at build time with -ldflags "-X main.version=<revision>".
var version = "dev"

const (
	// Ordinary requests drain within this window; persistent streams are then
	// cut so shutdown finishes before Kubernetes' 30-second termination deadline.
	drainTimeout    = 20 * time.Second
	shutdownTimeout = 25 * time.Second
	// Startup discovery must not hold the pod in not-ready indefinitely.
	startupProbeTimeout = 15 * time.Second
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	if len(os.Args) > 1 {
		fmt.Fprintf(os.Stderr, "usage: %s [healthcheck]\n", os.Args[0])
		os.Exit(2)
	}

	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid configuration: %v\n", err)
		os.Exit(1)
	}
	logOutput := os.Stdout
	if cfg.Transport == config.TransportStdio {
		logOutput = os.Stderr
	}
	logger := logging.New(logOutput, cfg.LogLevel)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, cfg, logger); err != nil {
		logger.Error("driftmower-mcp failed", "error", err)
		os.Exit(1)
	}
}

type services struct {
	clients    *kube.Clients
	reviews    *authz.CachedReviewer
	namespaces *kube.NamespaceLister
	scope      *authz.ScopeResolver
	mapping    auth.Mapping
	clusterID  *string
	catalog    *catalog.Catalog
	facts      *facts.Facts
	service    *service.Service
	judge      authz.Judge
}

func newServices(cfg *config.Config) (*services, error) {
	clients, err := kube.NewClients(cfg.Kubernetes)
	if err != nil {
		return nil, err
	}
	reviews := authz.NewCachedReviewer(authz.NewSubjectAccessReviewer(clients.Kubernetes.AuthorizationV1()), cfg.Kubernetes.SARCacheTTL, nil)
	namespaces := kube.NewNamespaceLister(clients.Kubernetes)
	var judge authz.Judge = authz.NewChecker(reviews)
	if cfg.AuthMode != "rbac" {
		judge = authz.ReadAll{}
	}
	cat := catalog.New(clients.Kubernetes, clients.Dynamic)
	svc := &services{}
	f := facts.New(facts.Options{
		Kubernetes:          clients.Kubernetes,
		Dynamic:             clients.Dynamic,
		Catalog:             cat,
		Judge:               judge,
		IngressDomainSuffix: cfg.Provisioning.IngressDomainSuffix,
		ClusterFactTTL:      cfg.Provisioning.ClusterFactTTL,
		TopologyTTL:         cfg.Provisioning.TopologyTTL,
		OperatorTTL:         cfg.Provisioning.OperatorTTL,
		// The identity is discovered after these facts are built.
		ClusterID: func() *string { return svc.clusterID },
	})

	*svc = services{
		clients:    clients,
		reviews:    reviews,
		namespaces: namespaces,
		catalog:    cat,
		facts:      f,
		judge:      judge,
		service:    service.New(f, judge, cfg.Provisioning.MaxNamespaces),
		scope: &authz.ScopeResolver{
			ListNamespaces: namespaces.List,
			Judge:          judge,
			MaxNamespaces:  cfg.Tenancy.MaxNamespaces,
		},
		mapping: auth.Mapping{
			ReadAll:        cfg.AuthMode != "rbac",
			UsernameClaim:  cfg.Kubernetes.UsernameClaim,
			GroupsClaim:    cfg.Kubernetes.GroupsClaim,
			UsernamePrefix: cfg.Kubernetes.UsernamePrefix,
			GroupsPrefix:   cfg.Kubernetes.GroupsPrefix,
		},
	}

	return svc, nil
}

func run(ctx context.Context, cfg *config.Config, logger *slog.Logger) error {
	logger.Info("starting driftmower-mcp", "version", version, "transport", cfg.Transport)

	m := metrics.New()
	var ready atomic.Bool
	g, gctx := errgroup.WithContext(ctx)

	// Probes answer not-ready while discovery runs, rather than refusing
	// connections.
	var health, drift *http.Server
	driftHandler := http.NewServeMux()
	if cfg.Transport == config.TransportHTTP {
		var err error
		if health, err = serve(g, net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.HealthPort)), httpserver.HealthHandler(&ready, m)); err != nil {
			return err
		}
		// Drift metrics carry every namespace's workloads, so they get a port
		// of their own that a NetworkPolicy opens only to the drift Prometheus.
		if drift, err = serve(g, net.JoinHostPort(cfg.Host, strconv.Itoa(driftMetricsPort)), driftHandler); err != nil {
			return err
		}
	}

	svc, err := newServices(cfg)
	if err != nil {
		return err
	}
	if cfg.Transport == config.TransportHTTP {
		driftHandler.Handle("GET /security-metrics", &securitymetrics.Exporter{Kubernetes: svc.clients.Kubernetes, Logger: logger, ServiceAccountsEnabled: cfg.UserAccess.Enabled})
	}

	oidcUsers, err := platformapis.HasResources(svc.clients.Kubernetes.Discovery(), "codemowers.cloud/v1", "oidcusers")
	if err != nil {
		return err
	}
	if !oidcUsers {
		logger.Info("OIDCUser CRD is not installed; Users, Groups and user/group links are disabled")
	}
	nodestatd, err := platformapis.HasResources(svc.clients.Kubernetes.Discovery(), "codemowers.io/v1alpha1", "containerimages", "sourcerepositories")
	if err != nil {
		return err
	}
	if !nodestatd {
		logger.Warn("nodestatd is not installed: ContainerImage or SourceRepository CRD is missing; GHSA advisories, vulnerabilities and Trivy scanning are disabled", "install", platformapis.NodestatdInstall, "k3s", "add --set containerd.socket=/run/k3s/containerd/containerd.sock", "cri-o", "add --set runtime=crio (needs a nodestatd release with CRI-O support)", "after", "restart Driftmower after installing")
		cfg.ScannerURL = ""
	}
	issuer := ""
	if cfg.OIDC != nil {
		issuer = cfg.OIDC.Issuer
	}
	probeCtx, cancel := context.WithTimeout(gctx, startupProbeTimeout)
	identity := cluster.Discover(probeCtx, svc.clients.Kubernetes, cfg.Cluster, issuer, logger)
	if cfg.Transport == config.TransportHTTP && cfg.AuthMode == "rbac" {
		checkAuthorizer(probeCtx, svc, logger)
	}
	cancel()
	svc.clusterID = identity.ID

	live := newWorkloads(gctx, cfg, svc, logger)
	if !nodestatd {
		live.MissingComponents = []string{"nodestatd"}
	}
	obs := newObservability(cfg, svc, m)
	var source mcpserver.FindingsSource
	if nodestatd {
		source = newFindings(cfg)
	}
	if source != nil && live != nil {
		namespace, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/namespace")
		if err == nil {
			name := os.Getenv("POD_SERVICE_ACCOUNT")
			if name == "" {
				name = "driftmower-mcp"
			}
			driftHandler.Handle("GET /drift-metrics", &drifthistory.Exporter{Source: source, Inventory: live.Cache, Kubernetes: live.Cache.Kubernetes, Dynamic: live.Cache.Dynamic,
				Identity: authz.Identity{User: "system:serviceaccount:" + strings.TrimSpace(string(namespace)) + ":" + name, Groups: []string{"system:serviceaccounts", "system:serviceaccounts:" + strings.TrimSpace(string(namespace)), "system:authenticated"}}})
		}
	}
	var history *observability.Service
	if cfg.DriftPrometheusURL != "" {
		history = &observability.Service{ScannerNamespace: cfg.ScannerNamespace, ScannerInstance: cfg.ScannerInstance, PrometheusURL: cfg.DriftPrometheusURL, MaxHistoryRange: 90 * 24 * time.Hour, Alignment: 5 * time.Minute, Kubernetes: svc.clients.Kubernetes, Judge: svc.judge,
			CVEHistoryEnabled: cfg.CVEHistoryEnabled, SAHistoryEnabled: cfg.SAHistoryEnabled,
			HoursPerUpgrade: cfg.HoursPerUpgrade, BuildAgeDaysPerUpgrade: cfg.BuildAgeDaysPerUpgrade,
			Backend: observability.NewGateway(observability.GatewayOptions{Next: observability.HTTPRequester(20 * time.Second), PrometheusURL: cfg.DriftPrometheusURL, PrometheusTimeout: 19 * time.Second})}
	}
	users := newUserAccess(cfg, svc)
	if users != nil {
		users.OIDCUsersDisabled = !oidcUsers
	}
	m.ObserveCaches(func() map[string]ttlcache.Stats {
		stats := svc.facts.CacheStats()
		stats["rbac_reviews"] = svc.reviews.Stats()
		stats["namespaces"] = svc.namespaces.Stats()
		if users != nil {
			stats["user_access"] = users.CacheStats()
		}
		return stats
	})
	if live != nil {
		m.ObserveWorkloadObjects(live.Cache.ObjectCounts)
	}
	server := mcpserver.New(mcpserver.Deps{
		Cluster:                identity,
		Version:                version,
		Logger:                 logger,
		Metrics:                m,
		Mapping:                svc.mapping,
		Scope:                  svc.scope,
		Catalog:                svc.catalog,
		Provisioning:           svc.service,
		Workloads:              live,
		Observability:          obs,
		Findings:               source,
		DriftHistory:           history,
		UserAccess:             users,
		ImageInventoryDisabled: !nodestatd,
	})

	if cfg.Transport == config.TransportStdio {
		logger.Info("driftmower-mcp started", "transport", "stdio", "cluster", identity.MCPServerName)

		return server.Run(ctx, &mcp.StdioTransport{})
	}

	authenticator := newAuthenticator(cfg, svc)
	if authenticator == nil {
		logger.Info("Anonymous read-only access enabled")
	}
	app, err := serve(g, net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)), httpserver.NewApp(httpserver.AppOptions{
		BrowserClientID: cfg.BrowserClientID, AllowedOrigins: cfg.AllowedOrigins,
		PublicURL:     cfg.PublicURL,
		Cluster:       identity,
		OAuthClientID: cfg.OAuthClientID,
		MCP:           server,
		Auth:          authenticator,
		AnonymousRead: cfg.AuthMode == "anonymous",
		SessionIdle:   cfg.SessionIdle,
		BrowserReads:  mcpserver.BrowserReads(obs, live, svc.mapping, history),
		Invalidate:    newInvalidator(cfg, svc, m, logger),
		Capabilities: &httpserver.Capabilities{
			Service: svc.service, Mapping: svc.mapping, Authenticated: authenticator != nil || cfg.AuthMode == "anonymous", Logger: logger,
		},
		Metrics: m,
		Logger:  logger,
	}))
	if err != nil {
		return err
	}

	if cfg.Kubernetes.RBACWatchEnabled {
		if err := authz.StartInvalidationWatch(gctx, svc.clients.Metadata, watchHooks(svc, m), logger); err != nil {
			return err
		}
		logger.Info("Watching RBAC, namespaces and CRDs to invalidate caches on change")
	}

	ready.Store(true)
	logger.Info("driftmower-mcp started", "addr", app.Addr, "cluster", identity.MCPServerName)

	g.Go(func() error {
		<-gctx.Done()
		ready.Store(false)
		logger.Info("shutting down")

		return shutdown(logger, app, health, drift)
	})

	return g.Wait()
}

// serve binds addr before returning, so a port conflict fails startup.
func serve(g *errgroup.Group, addr string, h http.Handler) (*http.Server, error) {
	srv := &http.Server{Addr: addr, Handler: h, ReadHeaderTimeout: 10 * time.Second}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	g.Go(func() error {
		if err := srv.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("serve %s: %w", addr, err)
		}

		return nil
	})

	return srv, nil
}

// newWorkloads starts the watch-backed inventory. Its watches begin on first
// use and stop with ctx.
func newWorkloads(ctx context.Context, cfg *config.Config, svc *services, logger *slog.Logger) *mcpserver.Workloads {
	c := &workloads.Cache{
		Kubernetes: svc.clients.Watch,
		Metadata:   svc.clients.Metadata,
		Dynamic:    svc.clients.WatchDynamic,
		Discovery:  svc.clients.Kubernetes.Discovery(),
		Judge:      svc.judge,
		Scope:      svc.scope,
		Logger:     logger,
		MayWatch:   selfMayWatch(svc.clients.Kubernetes),
	}
	c.Start(ctx)
	w := &mcpserver.Workloads{ScanURL: cfg.ScannerURL, ScanTokenFile: cfg.ScannerTokenFile, Cache: c, Metadata: svc.clients.Metadata, Judge: svc.judge, ArgoCDURL: cfg.ArgoCDURL}

	if cfg.Registry.URL != "" {
		w.Registry = &registry.Reader{URL: cfg.Registry.URL, TokenFile: cfg.Registry.TokenFile, HTTP: &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	}
	if cfg.WorkloadRestartEnabled {
		w.Actions = &workloads.Actions{Config: svc.clients.Config, Catalog: svc.catalog}
	}

	return w
}

// selfMayWatch asks the API server whether this server's own ServiceAccount
// may list and watch a collection in every namespace.
func selfMayWatch(k kubernetes.Interface) func(context.Context, schema.GroupVersionResource) (bool, error) {
	return func(ctx context.Context, gvr schema.GroupVersionResource) (bool, error) {
		for _, verb := range []string{"list", "watch"} {
			review, err := k.AuthorizationV1().SelfSubjectAccessReviews().Create(ctx, &authorizationv1.SelfSubjectAccessReview{
				Spec: authorizationv1.SelfSubjectAccessReviewSpec{ResourceAttributes: &authorizationv1.ResourceAttributes{
					Group: gvr.Group, Version: gvr.Version, Resource: gvr.Resource, Verb: verb,
				}},
			}, metav1.CreateOptions{})
			if err != nil {
				return false, err
			}
			if !review.Status.Allowed {
				return false, nil
			}
		}

		return true, nil
	}
}

// newObservability configures backend access, query sharing and request timeouts.
// Without observability configuration only list_volumes is offered, without usage figures.
func newObservability(cfg *config.Config, svc *services, m *metrics.Metrics) *observability.Service {
	o := &observability.Service{Kubernetes: svc.clients.Kubernetes, Judge: svc.judge, ExpandEnabled: cfg.WorkloadRestartEnabled}
	c := cfg.Observability
	if c == nil {
		return o
	}
	outcome := func(o string) { m.ObservabilityGuard.WithLabelValues(o).Inc() }
	o.PrometheusURL, o.LokiURL, o.LogsEnabled = c.PrometheusURL, c.LokiURL, true
	o.ScannerNamespace, o.ScannerInstance = cfg.ScannerNamespace, cfg.ScannerInstance
	o.CVEHistoryEnabled, o.SAHistoryEnabled = cfg.CVEHistoryEnabled, cfg.SAHistoryEnabled
	o.HoursPerUpgrade, o.BuildAgeDaysPerUpgrade = cfg.HoursPerUpgrade, cfg.BuildAgeDaysPerUpgrade
	o.PrometheusExternalURL = c.PrometheusExternalURL
	o.AlertmanagerURL, o.AlertmanagerTimeout = c.AlertmanagerURL, c.RequestTimeout
	o.Backend = observability.NewGateway(observability.GatewayOptions{
		Next:          observability.HTTPRequester(c.RequestTimeout),
		PrometheusURL: c.PrometheusURL,
		// Prometheus stops evaluating just before this server stops waiting.
		PrometheusTimeout: c.RequestTimeout - time.Second,
		OnOutcome:         outcome,
	})
	o.Alignment = c.Alignment

	return o
}

// newFindings reads driftmower-crawler's reports, when a crawler is
// configured.
func newFindings(cfg *config.Config) mcpserver.FindingsSource {
	if cfg.Crawler.URL == "" {
		return nil
	}

	return &findings.Client{URL: cfg.Crawler.URL, TokenFile: cfg.Crawler.TokenFile, HTTP: &http.Client{Timeout: 30 * time.Second}}
}

// newUserAccess enables OIDCUser listing and effective-rights inspection.
// Rules reviews impersonate the inspected user with this server's account.
func newUserAccess(cfg *config.Config, svc *services) *useraccess.Service {
	if !cfg.UserAccess.Enabled {
		return nil
	}

	return &useraccess.Service{
		Dynamic:        svc.clients.Dynamic,
		Discovery:      svc.clients.Kubernetes.Discovery(),
		Judge:          svc.judge,
		Scope:          svc.scope,
		ListNamespaces: svc.namespaces.List,
		Mapping:        svc.mapping,
		Namespace:      cfg.UserAccess.Namespace,
		Rules:          useraccess.NewImpersonatingReviewer(svc.clients.Config),
		CacheTTL:       cfg.UserAccess.CacheTTL,
	}
}

func newAuthenticator(cfg *config.Config, svc *services) *auth.Authenticator {
	if cfg.OIDC == nil {
		return nil
	}
	resource := cfg.PublicURL + "/mcp"
	audience := cfg.OIDC.Audience
	if audience == "" {
		audience = resource
	}
	a := &auth.Authenticator{
		OIDC: auth.NewOIDCVerifier(auth.OIDCOptions{
			Issuer:              cfg.OIDC.Issuer,
			JWKSURI:             cfg.OIDC.JWKSURI,
			Audience:            audience,
			NamespacesClaim:     cfg.OIDC.NamespacesClaim,
			JWKSBearerTokenFile: cfg.OIDC.JWKSBearerTokenFile,
			AllowedClientIDs:    cfg.OIDC.AllowedClientIDs,
			UsernameClaim:       cfg.Kubernetes.UsernameClaim,
			GroupsClaim:         cfg.Kubernetes.GroupsClaim,
		}),
		Resource: resource,
		Issuer:   cfg.OIDC.Issuer,
	}
	if cfg.ServiceAccountAuthEnabled {
		a.ServiceAccounts = auth.NewTokenReviewer(svc.clients.Kubernetes.AuthenticationV1())
		a.ServiceAccountAudience = cfg.ServiceAccountAudience
	}

	return a
}

func newInvalidator(cfg *config.Config, svc *services, m *metrics.Metrics, logger *slog.Logger) http.Handler {
	if cfg.Invalidate.SharedToken == "" && len(cfg.Invalidate.AllowedSubjects) == 0 {
		return nil
	}
	reviewer := auth.NewTokenReviewer(svc.clients.Kubernetes.AuthenticationV1())

	return &httpserver.Invalidator{
		SharedToken:     cfg.Invalidate.SharedToken,
		AllowedSubjects: cfg.Invalidate.AllowedSubjects,
		ReviewToken: func(ctx context.Context, token string) (string, error) {
			status, err := reviewer.Review(ctx, token)
			if err != nil || !status.Authenticated {
				return "", err
			}

			return status.User.Username, nil
		},
		UsernamePrefix:      cfg.Kubernetes.UsernamePrefix,
		ClearReviews:        svc.reviews.Clear,
		InvalidateNamespace: svc.reviews.InvalidateNamespace,
		InvalidateUser:      svc.reviews.InvalidateUser,
		InvalidateFacts:     svc.service.Invalidate,
		Metrics:             m,
		Logger:              logger,
	}
}

func watchHooks(svc *services, m *metrics.Metrics) authz.WatchHooks {
	invalidated := m.Invalidations.WithLabelValues("watch")

	return authz.WatchHooks{
		InvalidateNamespace: func(namespace string) {
			svc.reviews.InvalidateNamespace(namespace)
			invalidated.Inc()
		},
		ClearReviews: func() {
			svc.reviews.Clear()
			invalidated.Inc()
		},
		NamespacesChanged: svc.namespaces.Invalidate,
		DiscoveryChanged:  svc.service.Invalidate,
	}
}

// checkAuthorizer probes, once at startup, that this server may create
// SubjectAccessReviews and that the authorizer answers them. It cannot detect a
// wrong username mapping: system:basic-user lets every authenticated principal
// create SelfSubjectAccessReviews, so the review is allowed for any username.
// When it fails, every RBAC-derived answer will be unknown, and the operator
// should hear it now rather than from a confused agent.
func checkAuthorizer(ctx context.Context, svc *services, logger *slog.Logger) {
	allowed, err := authz.NewSubjectAccessReviewer(svc.clients.Kubernetes.AuthorizationV1()).Allowed(ctx,
		authz.Identity{User: svc.mapping.UsernamePrefix + "driftmower-mcp-selfcheck", Groups: []string{"system:authenticated"}},
		authz.Attributes{Group: "authorization.k8s.io", Resource: "selfsubjectaccessreviews", Verb: "create"})
	switch {
	case err != nil:
		logger.Warn("SubjectAccessReview is unavailable to the driftmower-mcp service account; RBAC-derived scope and access verdicts will report unknown", "error", err)
	case !allowed:
		logger.Warn("The cluster does not grant system:basic-user to system:authenticated; group-based access reviews may under-report")
	default:
		logger.Info("Kubernetes authorizer answers SubjectAccessReviews")
	}
}

// shutdown stops accepting connections, lets ordinary requests drain, then
// closes whatever streams remain.
func shutdown(logger *slog.Logger, servers ...*http.Server) error {
	deadline := time.Now().Add(shutdownTimeout)
	g := new(errgroup.Group)
	for _, srv := range servers {
		if srv == nil {
			continue
		}
		g.Go(func() error {
			ctx, cancel := context.WithTimeout(context.Background(), drainTimeout)
			defer cancel()
			if err := srv.Shutdown(ctx); err != nil {
				logger.Warn("closing remaining connections", "addr", srv.Addr, "error", err)

				return srv.Close()
			}

			return nil
		})
	}
	err := g.Wait()
	if time.Now().After(deadline) {
		return errors.New("shutdown exceeded its deadline")
	}

	return err
}

const driftMetricsPort = 3002

// healthcheck probes the local readiness endpoint, for container health
// checks in images without a shell or HTTP client.
func healthcheck() int {
	port := 3001
	if v := os.Getenv("DRIFTMOWER_MCP_HEALTH_PORT"); v != "" {
		if p, err := strconv.Atoi(v); err == nil {
			port = p
		}
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/readyz", port))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)

		return 1
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, resp.Status)

		return 1
	}

	return 0
}
