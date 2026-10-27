// Command driftmower-operator keeps a live, in-memory model of the cluster's
// workloads and serves it to authenticated callers over MCP.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/codemowers/driftmower-operator/internal/authz"
	"github.com/codemowers/driftmower-operator/internal/findings"
	"github.com/codemowers/driftmower-operator/internal/mcp"
	"github.com/codemowers/driftmower-operator/internal/workloads"
	"golang.org/x/sync/errgroup"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/metadata"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

var version = "dev"

func main() {
	var kubeconfig, listenAddr, healthAddr, audience, crawlerURL, crawlerToken, logLevel string
	flag.StringVar(&kubeconfig, "kubeconfig", env("KUBECONFIG", ""), "kubeconfig path; in-cluster configuration when empty")
	flag.StringVar(&listenAddr, "listen-addr", env("LISTEN_ADDR", ":8080"), "MCP endpoint address")
	flag.StringVar(&healthAddr, "health-addr", env("HEALTH_ADDR", ":8081"), "health endpoint address")
	flag.StringVar(&audience, "mcp-audience", env("MCP_AUDIENCE", ""), "token audience callers present, <service>.<namespace>")
	flag.StringVar(&crawlerURL, "crawler-url", env("CRAWLER_URL", ""), "driftmower-crawler base URL; empty disables the findings tools")
	flag.StringVar(&crawlerToken, "crawler-token-file", env("CRAWLER_TOKEN_FILE", "/var/run/secrets/driftmower/crawler/token"), "projected token for the crawler's audience")
	flag.StringVar(&logLevel, "log-level", env("LOG_LEVEL", "info"), "debug, info, warn or error")
	flag.Parse()

	var level slog.Level
	if level.UnmarshalText([]byte(logLevel)) != nil {
		level = slog.LevelInfo
	}
	log := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	if audience == "" {
		log.Error("MCP_AUDIENCE is required")
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	var crawlerClient *findings.Client
	if crawlerURL != "" {
		crawlerClient = &findings.Client{URL: crawlerURL, TokenFile: crawlerToken, HTTP: &http.Client{Timeout: 30 * time.Second}}
	}
	if err := run(ctx, kubeconfig, listenAddr, healthAddr, audience, crawlerClient, log); err != nil && !errors.Is(err, context.Canceled) {
		log.Error("driftmower-operator stopped", "error", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, kubeconfig, listenAddr, healthAddr, audience string, crawlerClient *findings.Client, log *slog.Logger) error {
	config, err := kubeConfig(kubeconfig)
	if err != nil {
		return err
	}
	config.UserAgent = "driftmower-operator/" + version
	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		return err
	}
	dynamicClient, err := dynamic.NewForConfig(config)
	if err != nil {
		return err
	}
	metadataClient, err := metadata.NewForConfig(config)
	if err != nil {
		return err
	}
	cache := workloads.NewCache(dynamicClient, metadataClient, clientset.Discovery(), log)
	server := &mcp.Server{Authorizer: authz.New(clientset, audience), Workloads: cache, Findings: crawlerClient, Log: log, Version: version}

	health := http.NewServeMux()
	health.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	health.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		if !cache.Synced() {
			http.Error(w, "inventory loading", http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte("ok"))
	})

	group, ctx := errgroup.WithContext(ctx)
	group.Go(func() error { cache.Run(ctx); return ctx.Err() })
	group.Go(func() error { return serve(ctx, listenAddr, server) })
	group.Go(func() error { return serve(ctx, healthAddr, health) })
	log.Info("started", "listen", listenAddr, "health", healthAddr, "audience", audience)
	return group.Wait()
}

func serve(ctx context.Context, addr string, handler http.Handler) error {
	srv := &http.Server{Addr: addr, Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(shutdown)
	}()
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return ctx.Err()
}

func kubeConfig(path string) (*rest.Config, error) {
	if path != "" {
		return clientcmd.BuildConfigFromFlags("", path)
	}
	return rest.InClusterConfig()
}

func env(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok && value != "" {
		return value
	}
	return fallback
}
