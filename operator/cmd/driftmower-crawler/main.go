// Command driftmower-crawler fetches releases and security advisories for
// the source repositories of images on the cluster and serves them, matched
// against deployed versions, to the driftmower operator. It is the only
// driftmower component with internet egress and holds no Secret access.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/codemowers/driftmower/operator/internal/authz"
	"github.com/codemowers/driftmower/operator/internal/crawler"
	"golang.org/x/sync/errgroup"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

var version = "dev"

func main() {
	var kubeconfig, listenAddr, healthAddr, uiAddr, audience, allowed, giteaHosts, logLevel string
	var cfg crawler.Config
	flag.StringVar(&kubeconfig, "kubeconfig", env("KUBECONFIG", ""), "kubeconfig path; in-cluster configuration when empty")
	flag.StringVar(&listenAddr, "listen-addr", env("LISTEN_ADDR", ":8080"), "report API address")
	flag.StringVar(&healthAddr, "health-addr", env("HEALTH_ADDR", ":8081"), "health endpoint address")
	// Loopback only: the page has no authentication and is reached through
	// kubectl port-forward, which Kubernetes RBAC authorizes.
	flag.StringVar(&uiAddr, "ui-addr", env("UI_ADDR", "127.0.0.1:8082"), "inspection web UI address; empty disables it")
	flag.StringVar(&audience, "audience", env("CRAWLER_AUDIENCE", ""), "token audience callers present, <service>.<namespace>")
	flag.StringVar(&allowed, "allowed-callers", env("ALLOWED_CALLERS", ""), "comma-separated usernames allowed to read reports")
	flag.StringVar(&giteaHosts, "gitea-hosts", env("GITEA_HOSTS", ""), "comma-separated Gitea or Forgejo hosts besides codeberg.org and gitea.com")
	flag.DurationVar(&cfg.Interval, "interval", envDuration("CRAWL_INTERVAL", 6*time.Hour), "interval between crawls of a source")
	flag.StringVar(&logLevel, "log-level", env("LOG_LEVEL", "info"), "debug, info, warn or error")
	flag.Parse()
	// The token stays out of flags, which show in process listings.
	cfg.GitHubToken = os.Getenv("GITHUB_TOKEN")
	cfg.GiteaHosts = split(giteaHosts)

	var level slog.Level
	if level.UnmarshalText([]byte(logLevel)) != nil {
		level = slog.LevelInfo
	}
	log := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	if audience == "" || allowed == "" {
		log.Error("CRAWLER_AUDIENCE and ALLOWED_CALLERS are required")
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, kubeconfig, listenAddr, healthAddr, uiAddr, audience, split(allowed), cfg, log); err != nil && !errors.Is(err, context.Canceled) {
		log.Error("driftmower-crawler stopped", "error", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, kubeconfig, listenAddr, healthAddr, uiAddr, audience string, allowed []string, cfg crawler.Config, log *slog.Logger) error {
	config, err := kubeConfig(kubeconfig)
	if err != nil {
		return err
	}
	config.UserAgent = "driftmower-crawler/" + version
	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		return err
	}
	dynamicClient, err := dynamic.NewForConfig(config)
	if err != nil {
		return err
	}
	c := crawler.New(cfg, dynamicClient, log)
	api := &crawler.API{Crawler: c, Authorizer: authz.New(clientset, audience), Allowed: allowed}

	health := http.NewServeMux()
	health.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	health.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		if !c.Synced() {
			http.Error(w, "sources loading", http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte("ok"))
	})

	group, ctx := errgroup.WithContext(ctx)
	group.Go(func() error { c.Run(ctx); return ctx.Err() })
	group.Go(func() error { return serve(ctx, listenAddr, api) })
	group.Go(func() error { return serve(ctx, healthAddr, health) })
	if uiAddr != "" {
		group.Go(func() error { return serve(ctx, uiAddr, c.UI()) })
	}
	log.Info("started", "listen", listenAddr, "health", healthAddr, "ui", uiAddr, "audience", audience, "githubToken", cfg.GitHubToken != "")
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

func split(value string) []string {
	var out []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			out = append(out, item)
		}
	}
	return out
}

func env(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok && value != "" {
		return value
	}
	return fallback
}

func envDuration(key string, fallback time.Duration) time.Duration {
	if value, err := time.ParseDuration(env(key, "")); err == nil {
		return value
	}
	return fallback
}
