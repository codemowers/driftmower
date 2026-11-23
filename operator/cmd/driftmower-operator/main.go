package main

import (
	"bytes"
	"compress/gzip"
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

	"github.com/codemowers/driftmower/internal/imageanalysis"
	"github.com/codemowers/driftmower/internal/scanner"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/leaderelection"
	"k8s.io/client-go/tools/leaderelection/resourcelock"
)

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, nil)))
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	if len(os.Args) > 1 && os.Args[1] == "analyze-image" {
		if err := analyzeImage(ctx); err != nil {
			slog.Error("image analysis failed", "error", err)
			os.Exit(1)
		}
		return
	}
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
	cfg := scanner.Config{CPURequest: os.Getenv("SCAN_CPU_REQUEST"), Strategy: os.Getenv("SCAN_STRATEGY"), ReaderServiceAccount: os.Getenv("SCANNER_READER_ACCOUNT"), Instance: os.Getenv("SCANNER_INSTANCE"), ServiceAccount: os.Getenv("SCANNER_SERVICE_ACCOUNT"), Namespace: ns, Image: os.Getenv("SCANNER_IMAGE"), TrivyImage: os.Getenv("TRIVY_IMAGE"), DatabaseImage: os.Getenv("TRIVY_DB_IMAGE"), URL: os.Getenv("SCANNER_URL"), Audience: "driftmower-scans." + ns, CacheDir: "/cache/sbom", PriorityClass: os.Getenv("SCAN_PRIORITY_CLASS"), MaxBytes: int64(integer("SBOM_CACHE_MIB", 2048)) << 20, Parallelism: integer("SCAN_PARALLELISM", 2), MaxFailedPods: integer("SCAN_MAX_FAILED_PODS", scanner.DefaultMaxFailedPods), ReadAllFiles: os.Getenv("SCAN_DAC_READ_SEARCH") == "true", PullSecrets: strings.FieldsFunc(os.Getenv("IMAGE_PULL_SECRETS"), func(r rune) bool { return r == ',' })}
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
	if contentType != scanner.OversizedSBOMMediaType {
		analysisPath := filepath.Join(filepath.Dir(output), "analysis.json.gz")
		analysisFile, readErr := os.Open(analysisPath)
		if readErr == nil {
			reader, err := gzip.NewReader(analysisFile)
			if err != nil {
				analysisFile.Close()
				return err
			}
			var report imageanalysis.Report
			decoder := json.NewDecoder(io.LimitReader(reader, scanner.MaxAnalysisBytes+1))
			err = decoder.Decode(&report)
			if err == nil && decoder.Decode(new(any)) != io.EOF {
				err = errors.New("invalid filesystem report trailer")
			}
			reader.Close()
			analysisFile.Close()
			if err != nil {
				return err
			}
			body, err = imageanalysis.MergeCycloneDX(body, report, "complete")
			if err != nil {
				return err
			}
		} else if !errors.Is(readErr, os.ErrNotExist) {
			return readErr
		}
	}
	encoding := ""
	if contentType != scanner.OversizedSBOMMediaType {
		if len(body) > scanner.MaxSBOMBytes {
			body, err = json.Marshal(scanner.SBOMSizeReport{SizeBytes: int64(len(body))})
			if err != nil {
				return err
			}
			contentType = scanner.OversizedSBOMMediaType
		} else {
			var compressed bytes.Buffer
			writer := gzip.NewWriter(&compressed)
			if _, err := writer.Write(body); err != nil {
				return err
			}
			if err := writer.Close(); err != nil {
				return err
			}
			body, encoding = compressed.Bytes(), "gzip"
		}
	}
	err = uploadArtifact(ctx, client, url, token, contentType, encoding, body, delay)
	if err == nil && contentType == scanner.OversizedSBOMMediaType {
		return errors.New("SBOM exceeds 32 MiB result limit")
	}
	return err
}

// Retry transient startup/network failures without rerunning the image scan.
func uploadArtifact(ctx context.Context, client *http.Client, url, token, contentType, encoding string, body []byte, delay time.Duration) error {
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
		if encoding != "" {
			request.Header.Set("Content-Encoding", encoding)
		}
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

func analyzeImage(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	inspectCtx, inspectCancel := context.WithTimeout(ctx, 8*time.Minute)
	defer inspectCancel()
	report, err := imageanalysis.Inspect(inspectCtx, "/target")
	if err != nil {
		return err
	}
	var body bytes.Buffer
	writer := gzip.NewWriter(&body)
	if err := json.NewEncoder(writer).Encode(report); err != nil {
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	// The analyzer runs as namespaced root, while the uploader uses the Pod's
	// non-root identity. This temporary report contains observations, not file
	// contents or credentials, and must be readable across that handoff.
	if err := writeAnalysisHandoff("/result/analysis.json.gz", body.Bytes()); err != nil {
		return err
	}
	token, err := os.ReadFile("/token/token")
	if err != nil {
		return err
	}
	artifact, err := imageanalysis.MergeCycloneDX(nil, report, "pending")
	if err != nil {
		return err
	}
	var merged bytes.Buffer
	mergedWriter := gzip.NewWriter(&merged)
	if _, err := mergedWriter.Write(artifact); err != nil {
		return err
	}
	if err := mergedWriter.Close(); err != nil {
		return err
	}
	return uploadArtifact(ctx, &http.Client{Timeout: 10 * time.Second}, os.Getenv("UPLOAD_URL"), strings.TrimSpace(string(token)), "application/vnd.cyclonedx+json", "gzip", merged.Bytes(), time.Second)
}

// Match the readable result files produced by Trivy in the same Pod-owned
// emptyDir; no filesystem report is exposed outside the scan Pod.
func writeAnalysisHandoff(path string, body []byte) error {
	if err := os.WriteFile(path, body, 0600); err != nil {
		return err
	}
	// Set permissions explicitly: the analyzer may inherit a restrictive umask.
	return os.Chmod(path, 0644)
}
