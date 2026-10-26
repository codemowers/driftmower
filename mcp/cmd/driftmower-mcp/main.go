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

	"golang.org/x/sync/errgroup"

	"github.com/codemowers/driftmower-mcp/internal/config"
	"github.com/codemowers/driftmower-mcp/internal/httpserver"
	"github.com/codemowers/driftmower-mcp/internal/logging"
	"github.com/codemowers/driftmower-mcp/internal/metrics"
)

// version is set at build time with -ldflags "-X main.version=<revision>".
var version = "dev"

const (
	// Ordinary requests drain within this window; persistent streams are then
	// cut so shutdown finishes before Kubernetes' 30-second termination deadline.
	drainTimeout    = 20 * time.Second
	shutdownTimeout = 25 * time.Second
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

func run(ctx context.Context, cfg *config.Config, logger *slog.Logger) error {
	logger.Info("starting driftmower-mcp", "version", version, "transport", cfg.Transport,
		"cluster", cfg.Cluster.MCPServerName)

	if cfg.Transport == config.TransportStdio {
		return errors.New("the stdio transport is not implemented yet")
	}

	m := metrics.New()
	var ready atomic.Bool

	health := &http.Server{
		Addr:              net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.HealthPort)),
		Handler:           httpserver.HealthHandler(&ready, m),
		ReadHeaderTimeout: 10 * time.Second,
	}
	app := &http.Server{
		Addr:              net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)),
		Handler:           m.Instrument(http.NotFoundHandler()),
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Bind both ports before reporting ready, so a port conflict fails startup.
	g, gctx := errgroup.WithContext(ctx)
	for _, srv := range []*http.Server{health, app} {
		ln, err := net.Listen("tcp", srv.Addr)
		if err != nil {
			return err
		}
		g.Go(func() error {
			if err := srv.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
				return fmt.Errorf("serve %s: %w", srv.Addr, err)
			}

			return nil
		})
	}
	ready.Store(true)
	logger.Info("driftmower-mcp started", "addr", app.Addr, "healthAddr", health.Addr)

	g.Go(func() error {
		<-gctx.Done()
		ready.Store(false)
		logger.Info("shutting down")

		return shutdown(logger, app, health)
	})

	return g.Wait()
}

// shutdown stops accepting connections, lets ordinary requests drain, then
// closes whatever streams remain.
func shutdown(logger *slog.Logger, servers ...*http.Server) error {
	deadline := time.Now().Add(shutdownTimeout)
	g := new(errgroup.Group)
	for _, srv := range servers {
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
