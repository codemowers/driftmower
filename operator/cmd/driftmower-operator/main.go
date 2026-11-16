package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/codemowers/driftmower/internal/scanner"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/leaderelection"
	"k8s.io/client-go/tools/leaderelection/resourcelock"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	if len(os.Args) > 1 && os.Args[1] == "upload" {
		if err := upload(ctx); err != nil {
			slog.Error("scan failed", "error", err)
			os.Exit(1)
		}
		return
	}
	if err := run(ctx, cancel); err != nil && !errors.Is(err, context.Canceled) {
		slog.Error("operator stopped", "error", err)
		os.Exit(1)
	}
}
func integer(name string, fallback int) int {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		panic("invalid " + name)
	}
	return n
}
func run(ctx context.Context, cancel context.CancelFunc) error {
	namespaceBytes, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/namespace")
	if err != nil {
		return err
	}
	ns := strings.TrimSpace(string(namespaceBytes))
	config, err := rest.InClusterConfig()
	if err != nil {
		return err
	}
	kube, err := kubernetes.NewForConfig(config)
	if err != nil {
		return err
	}
	dyn, err := dynamic.NewForConfig(config)
	if err != nil {
		return err
	}
	cfg := scanner.Config{ReaderServiceAccount: os.Getenv("SCANNER_READER_ACCOUNT"), Instance: os.Getenv("SCANNER_INSTANCE"), ServiceAccount: os.Getenv("SCANNER_SERVICE_ACCOUNT"), Namespace: ns, Image: os.Getenv("SCANNER_IMAGE"), TrivyImage: os.Getenv("TRIVY_IMAGE"), DatabaseImage: os.Getenv("TRIVY_DB_IMAGE"), URL: os.Getenv("SCANNER_URL"), Audience: "driftmower-scans." + ns, CacheDir: "/cache/sbom", PriorityClass: os.Getenv("SCAN_PRIORITY_CLASS"), MaxBytes: int64(integer("SBOM_CACHE_MIB", 2048)) << 20, Parallelism: integer("SCAN_PARALLELISM", 2), PullSecrets: strings.FieldsFunc(os.Getenv("IMAGE_PULL_SECRETS"), func(r rune) bool { return r == ',' })}
	if cfg.URL == "" {
		cfg.URL = "http://driftmower-operator." + ns + ".svc:8080"
	}
	if cfg.Image == "" || cfg.TrivyImage == "" || cfg.DatabaseImage == "" || cfg.PriorityClass == "" {
		return errors.New("SCANNER_IMAGE, TRIVY_IMAGE, TRIVY_DB_IMAGE and SCAN_PRIORITY_CLASS are required")
	}
	controller := &scanner.Controller{Config: cfg, Kube: kube, Dynamic: dyn, Log: slog.Default()}
	server := &http.Server{Addr: "[::]:8080", Handler: controller.Handler(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 60 * time.Second, WriteTimeout: 60 * time.Second}
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("HTTP server failed", "error", err)
			cancel()
		}
	}()
	lockName := "driftmower-scanner"
	if cfg.Instance != "" {
		lockName = cfg.Instance + "-scanner"
	}
	hostname, _ := os.Hostname()
	leaderelection.RunOrDie(ctx, leaderelection.LeaderElectionConfig{
		Lock:          &resourcelock.LeaseLock{LeaseMeta: metav1.ObjectMeta{Name: lockName, Namespace: ns}, Client: kube.CoordinationV1(), LockConfig: resourcelock.ResourceLockConfig{Identity: hostname}},
		LeaseDuration: 30 * time.Second, RenewDeadline: 20 * time.Second, RetryPeriod: 5 * time.Second,
		Callbacks: leaderelection.LeaderCallbacks{OnStartedLeading: func(ctx context.Context) {
			if err := controller.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
				slog.Error("dispatcher failed", "error", err)
				cancel()
			}
		}, OnStoppedLeading: cancel},
	})
	shutdown, done := context.WithTimeout(context.Background(), 10*time.Second)
	defer done()
	return server.Shutdown(shutdown)
}
func upload(ctx context.Context) error {
	token, err := os.ReadFile("/token/token")
	if err != nil {
		return err
	}
	return uploadFile(ctx, &http.Client{Timeout: 10 * time.Second}, os.Getenv("UPLOAD_URL"), strings.TrimSpace(string(token)), "/result/sbom.json", time.Second)
}

func uploadFile(ctx context.Context, client *http.Client, url, token, output string, delay time.Duration) error {
	info, err := os.Stat(output)
	if err != nil {
		return err
	}
	contentType := "application/vnd.cyclonedx+json"
	var body []byte
	if info.Size() > scanner.MaxSBOMBytes {
		// Report the measured size to the long-lived operator so it can expose
		// metrics even though the artifact itself cannot be accepted.
		body, err = json.Marshal(scanner.SBOMSizeReport{SizeBytes: info.Size()})
		contentType = scanner.OversizedSBOMMediaType
	} else {
		body, err = os.ReadFile(output)
		if err == nil {
			metadata, readErr := os.ReadFile(filepath.Join(filepath.Dir(output), "db-metadata.json"))
			if readErr == nil {
				var db struct{ UpdatedAt time.Time }
				if err = json.Unmarshal(metadata, &db); err != nil {
					return err
				}
				if db.UpdatedAt.IsZero() {
					return errors.New("database version timestamp missing")
				}
				reason, reasonErr := os.ReadFile(filepath.Join(filepath.Dir(output), "partial-reason"))
				if reasonErr != nil && !errors.Is(reasonErr, os.ErrNotExist) {
					return reasonErr
				}
				body, err = scanner.AnnotateArtifact(body, db.UpdatedAt.UTC().Format(time.RFC3339Nano), string(reason))
			} else if !errors.Is(readErr, os.ErrNotExist) {
				return readErr
			}
		}
	}
	if err != nil {
		return err
	}
	err = uploadArtifact(ctx, client, url, token, contentType, body, delay)
	if err == nil && info.Size() > scanner.MaxSBOMBytes {
		return errors.New("SBOM exceeds 32 MiB result limit")
	}
	return err
}

// Retry transient startup/network failures without rerunning the image scan.
func uploadArtifact(ctx context.Context, client *http.Client, url, token, contentType string, body []byte, delay time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	var lastErr error
	for attempt := 0; attempt < 6; attempt++ {
		if attempt > 0 {
			timer := time.NewTimer(delay << (attempt - 1))
			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
			}
		}
		request, err := http.NewRequestWithContext(ctx, "PUT", url, bytes.NewReader(body))
		if err != nil {
			return err
		}
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", contentType)
		response, err := client.Do(request)
		if err != nil {
			lastErr = err
			continue
		}
		_, _ = io.Copy(io.Discard, response.Body)
		response.Body.Close()
		if response.StatusCode == http.StatusCreated {
			return nil
		}
		lastErr = fmt.Errorf("artifact upload: HTTP %d", response.StatusCode)
		if response.StatusCode != http.StatusTooManyRequests && response.StatusCode < 500 {
			return lastErr
		}
	}
	return lastErr
}
