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
	"sync/atomic"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"golang.org/x/sync/errgroup"

	"github.com/codemowers/driftmower-mcp/internal/auth"
	"github.com/codemowers/driftmower-mcp/internal/authz"
	"github.com/codemowers/driftmower-mcp/internal/catalog"
	"github.com/codemowers/driftmower-mcp/internal/cluster"
	"github.com/codemowers/driftmower-mcp/internal/config"
	"github.com/codemowers/driftmower-mcp/internal/httpserver"
	"github.com/codemowers/driftmower-mcp/internal/kube"
	"github.com/codemowers/driftmower-mcp/internal/logging"
	"github.com/codemowers/driftmower-mcp/internal/mcpserver"
	"github.com/codemowers/driftmower-mcp/internal/metrics"
	"github.com/codemowers/driftmower-mcp/internal/provisioning/facts"
	"github.com/codemowers/driftmower-mcp/internal/provisioning/service"
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
	logger := logging.New(os.Stderr, cfg.LogLevel)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, cfg, logger); err != nil {
		logger.Error("driftmower-mcp failed", "error", err)
		os.Exit(1)
	}
}

// services are the long-lived components shared by every session.
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
}

func newServices(cfg *config.Config) (*services, error) {
	clients, err := kube.NewClients(cfg.Kubernetes)
	if err != nil {
		return nil, err
	}
	reviews := authz.NewCachedReviewer(authz.NewSubjectAccessReviewer(clients.Kubernetes.AuthorizationV1()), cfg.Kubernetes.SARCacheTTL, nil)
	namespaces := kube.NewNamespaceLister(clients.Kubernetes)
	judge := authz.NewChecker(reviews)
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
		service:    service.New(f, judge, cfg.Provisioning.MaxNamespaces),
		scope: &authz.ScopeResolver{
			ListNamespaces: namespaces.List,
			Judge:          judge,
			MaxNamespaces:  cfg.Tenancy.MaxNamespaces,
		},
		mapping: auth.Mapping{
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
	var health *http.Server
	if cfg.Transport == config.TransportHTTP {
		var err error
		if health, err = serve(g, net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.HealthPort)), httpserver.HealthHandler(&ready, m)); err != nil {
			return err
		}
	}

	svc, err := newServices(cfg)
	if err != nil {
		return err
	}

	issuer := ""
	if cfg.OIDC != nil {
		issuer = cfg.OIDC.Issuer
	}
	probeCtx, cancel := context.WithTimeout(gctx, startupProbeTimeout)
	identity := cluster.Discover(probeCtx, svc.clients.Kubernetes, cfg.Cluster, issuer, logger)
	if cfg.Transport == config.TransportHTTP {
		checkAuthorizer(probeCtx, svc, logger)
	}
	cancel()
	svc.clusterID = identity.ID

	server := mcpserver.New(mcpserver.Deps{
		Cluster:      identity,
		Version:      version,
		Logger:       logger,
		Metrics:      m,
		Mapping:      svc.mapping,
		Scope:        svc.scope,
		Catalog:      svc.catalog,
		Provisioning: svc.service,
	})

	if cfg.Transport == config.TransportStdio {
		logger.Info("driftmower-mcp started", "transport", "stdio", "cluster", identity.MCPServerName)

		return server.Run(ctx, &mcp.StdioTransport{})
	}

	authenticator := newAuthenticator(cfg, svc)
	if authenticator == nil {
		logger.Warn("HTTP transport is serving unauthenticated; do not expose it through an Ingress in this state")
	}
	app, err := serve(g, net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)), httpserver.NewApp(httpserver.AppOptions{
		PublicURL:     cfg.PublicURL,
		Cluster:       identity,
		OAuthClientID: cfg.OAuthClientID,
		MCP:           server,
		Auth:          authenticator,
		SessionIdle:   cfg.SessionIdle,
		Invalidate:    newInvalidator(cfg, svc, m, logger),
		Capabilities: &httpserver.Capabilities{
			Service: svc.service, Mapping: svc.mapping, Authenticated: authenticator != nil, Logger: logger,
		},
		WebUI:   cfg.WebUI.Enabled,
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

		return shutdown(logger, app, health)
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
