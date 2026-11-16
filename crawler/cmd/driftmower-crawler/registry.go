package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/codemowers/driftmower/crawler/internal/authz"
	"github.com/codemowers/driftmower/internal/crawler"
	"github.com/codemowers/driftmower/internal/registry"
	"github.com/prometheus/client_golang/prometheus"
	promcollectors "github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"golang.org/x/sync/errgroup"
	"k8s.io/client-go/kubernetes"
)

func registryMain() {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	if err := runRegistry(ctx); err != nil && !errors.Is(err, context.Canceled) {
		slog.Error("registry scraper stopped", "error", err)
		os.Exit(1)
	}
}

func runRegistry(ctx context.Context) error {
	configFile := env("REGISTRY_CONFIG_FILE", "/etc/driftmower-registry/repositories.json")
	initial, err := registry.LoadConfig(configFile)
	if err != nil {
		return err
	}
	store, err := registry.OpenStore(env("REGISTRY_DATA_DIR", "/data"))
	if err != nil {
		return err
	}
	store.Configure(initial.Repositories)
	cfg, err := kubeConfig(env("KUBECONFIG", ""))
	if err != nil {
		return err
	}
	kube, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return err
	}
	audience, allowed := os.Getenv("REGISTRY_AUDIENCE"), split(os.Getenv("ALLOWED_CALLERS"))
	if audience == "" || len(allowed) == 0 {
		return errors.New("REGISTRY_AUDIENCE and ALLOWED_CALLERS are required")
	}
	authorizer := authz.New(kube, audience)
	status := &registry.RegistryStatusTracker{}
	status.Configure(initial.Repositories)
	api := &registry.API{Store: store, Status: status, Allowed: allowed, Authenticate: func(ctx context.Context, token string) (string, error) {
		id, err := authorizer.Authenticate(ctx, token)
		if err != nil {
			return "", err
		}
		return id.User, nil
	}}
	scraper := &registry.Scraper{Client: &registry.Client{HTTP: crawler.PublicHTTPClient(), Status: status, CredentialsFile: os.Getenv("REGISTRY_CREDENTIALS_FILE"), GitHubTokenFile: os.Getenv("GHCR_TOKEN_FILE"), GitHubUsername: os.Getenv("GHCR_USERNAME")}, Store: store, ConfigFile: configFile, Log: slog.Default()}
	collectors := prometheus.NewRegistry()
	collectors.MustRegister(status, store, promcollectors.NewGoCollector(), promcollectors.NewProcessCollector(promcollectors.ProcessCollectorOpts{}))
	metrics := http.NewServeMux()
	metrics.Handle("GET /metrics", promhttp.HandlerFor(collectors, promhttp.HandlerOpts{}))
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.Handle("/", api.Handler())

	group, ctx := errgroup.WithContext(ctx)
	group.Go(func() error { return scraper.Run(ctx) })
	group.Go(func() error { return serve(ctx, env("METRICS_ADDR", ":8081"), metrics) })
	group.Go(func() error { return serve(ctx, env("LISTEN_ADDR", ":8080"), mux) })
	return group.Wait()
}
