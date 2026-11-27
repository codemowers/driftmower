// Command driftmower-crawler fetches releases and security advisories for
// the source repositories of images on the cluster and serves them, matched
// against deployed versions, to driftmower-mcp. It is the only
// driftmower component with internet egress and holds no Secret access.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/codemowers/driftmower/crawler/internal/authz"
	"github.com/codemowers/driftmower/internal/crawler"
	"golang.org/x/sync/errgroup"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

var version = "dev"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "registry" {
		registryMain()
		return
	}
	var kubeconfig, listenAddr, healthAddr, uiAddr, audience, allowed, giteaHosts, logLevel string
	var cfg crawler.Config
	var cacheMiB int64
	var lifecycleEnabled bool
	var lifecycleRules string
	var lifecycleInterval time.Duration
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
	flag.StringVar(&cfg.CacheDir, "cache-dir", env("CRAWLER_CACHE_DIR", "/data"), "persistent crawler cache directory")
	flag.BoolVar(&lifecycleEnabled, "lifecycle", env("LIFECYCLE_ENABLED", "true") == "true", "fetch endoflife.date metadata")
	flag.StringVar(&lifecycleRules, "lifecycle-rules", env("LIFECYCLE_RULES_FILE", ""), "optional lifecycle mapping overrides")
	flag.DurationVar(&lifecycleInterval, "lifecycle-interval", envDuration("LIFECYCLE_INTERVAL", 14*24*time.Hour), "lifecycle metadata TTL")
	flag.Int64Var(&cacheMiB, "cache-mib", 512, "maximum compressed crawler cache MiB")
	if value := os.Getenv("CRAWLER_CACHE_MIB"); value != "" {
		if _, err := fmt.Sscan(value, &cacheMiB); err != nil {
			slog.Error("invalid CRAWLER_CACHE_MIB")
			os.Exit(1)
		}
	}
	flag.Parse()
	cfg.CacheMaxBytes = cacheMiB << 20
	if cacheMiB < 128 {
		slog.Error("cache-mib must be at least 128")
		os.Exit(1)
	}
	// The token stays out of flags, which show in process listings.
	cfg.LifecycleEnabled = lifecycleEnabled
	cfg.LifecycleRulesFile = lifecycleRules
	cfg.LifecycleInterval = lifecycleInterval
	cfg.GitHubToken = os.Getenv("GITHUB_TOKEN")
	cfg.GiteaHosts = split(giteaHosts)
	if raw := os.Getenv("GITHUB_ENTERPRISE_TOKEN_FILES"); raw != "" {
		files := map[string]string{}
		if err := json.Unmarshal([]byte(raw), &files); err != nil {
			slog.Error("invalid GITHUB_ENTERPRISE_TOKEN_FILES")
			os.Exit(1)
		}
		cfg.GitHubEnterprise = map[string]string{}
		for host, file := range files {
			parsed, err := url.Parse("https://" + host)
			if err != nil || parsed.Host != host || parsed.User != nil || parsed.Path != "" || host == "github.com" || host == "api.github.com" {
				slog.Error("invalid GitHub Enterprise host", "host", host)
				os.Exit(1)
			}
			token, err := os.ReadFile(file)
			if err != nil && !os.IsNotExist(err) {
				slog.Error("cannot read GitHub Enterprise token file", "host", host)
				os.Exit(1)
			}
			cfg.GitHubEnterprise[host] = strings.TrimSpace(string(token))
		}
	}

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
	if cfg.LifecycleEnabled {
		if err := c.OpenLifecycle(cfg.LifecycleRulesFile, cfg.LifecycleInterval); err != nil {
			return err
		}
	}
	authorizer := authz.New(clientset, audience)
	authenticate := func(ctx context.Context, token string) (string, error) {
		id, err := authorizer.Authenticate(ctx, token)
		if err != nil {
			return "", err
		}
		return id.User, nil
	}
	api := &crawler.API{Crawler: c, Authenticate: authenticate, Allowed: allowed}
	mux := http.NewServeMux()
	mux.Handle("/v1/", api)
	if os.Getenv("MCP_ENABLED") == "true" {
		mux.Handle("/mcp", c.MCP(version, func(r *http.Request) error {
			token, found := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
			if !found {
				return errors.New("missing bearer token")
			}
			id, err := authorizer.Authenticate(r.Context(), token)
			if err != nil {
				return err
			}
			if slices.Contains(allowed, id.User) {
				return nil
			}
			return authorizer.MayUseMCP(r.Context(), id, "driftmower-crawler")
		}))
	}

	if authorizeURL := os.Getenv("BROWSER_AUTHORIZE_URL"); authorizeURL != "" {
		origins := split(os.Getenv("BROWSER_ALLOWED_ORIGINS"))
		for _, key := range []string{"BROWSER_MCP_ORIGIN", "BROWSER_UI_ORIGIN"} {
			if origin := os.Getenv(key); origin != "" {
				origins = append(origins, strings.TrimRight(origin, "/"))
			}
		}
		mux.Handle("/crawler/", http.StripPrefix("/crawler", crawler.BrowserAPI(c, authorizeURL, origins)))
	}

	health := http.NewServeMux()
	health.Handle("GET /metrics", c.Metrics())
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
	group.Go(func() error { c.RunLifecycle(ctx); return ctx.Err() })
	group.Go(func() error { return serve(ctx, listenAddr, mux) })
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
