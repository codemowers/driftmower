package scanner

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/codemowers/driftmower/internal/imageanalysis"
	authv1 "k8s.io/api/authentication/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	ktesting "k8s.io/client-go/testing"
)

func mergedTestReport() imageanalysis.Report {
	m := time.Date(2018, 9, 28, 17, 5, 8, 0, time.UTC)
	return imageanalysis.Report{SchemaVersion: 1, NewestFileLimit: 1000, ObservedAt: "2026-11-20T00:00:00Z", Entries: 1, Files: 1, MIME: map[string]int{"application/octet-stream": 1}, LinkingCounts: map[string]int{"static": 1}, Tools: map[string][]string{}, LatestFileModifiedAt: &m, LatestFilePath: "/server", NewestFiles: []imageanalysis.File{{Path: "/server", ModifiedAt: m, Size: 123, MIME: "application/octet-stream"}}, Binaries: []imageanalysis.Binary{{Path: "/server", Linking: "static"}}}
}

func TestOneArtifactRetainsStaticEvidenceAcrossFailedTrivyAndFinalUpload(t *testing.T) {
	for _, trivySucceeds := range []bool{false, true} {
		t.Run(map[bool]string{false: "failed-vulnerabilities", true: "complete-vulnerabilities"}[trivySucceeds], func(t *testing.T) {
			ctx := context.Background()
			c, image, key := testController(t, 1)
			c.Config.MaxBytes = 32 << 20
			c.Config.Audience = "test-scans"
			if err := dispatchTest(t, c, image, key); err != nil {
				t.Fatal(err)
			}
			pod := currentPod(t, c)
			pod.UID = "bound-uid"
			_, _ = c.Kube.CoreV1().Pods("test").Update(ctx, pod, metav1.UpdateOptions{})
			c.Kube.(*fake.Clientset).PrependReactor("create", "tokenreviews", func(ktesting.Action) (bool, runtime.Object, error) {
				return true, &authv1.TokenReview{Status: authv1.TokenReviewStatus{Authenticated: true, Audiences: []string{c.Config.Audience}, User: authv1.UserInfo{Username: "system:serviceaccount:test:" + c.Config.scanServiceAccount(), Extra: map[string]authv1.ExtraValue{"authentication.kubernetes.io/pod-name": {pod.Name}, "authentication.kubernetes.io/pod-uid": {string(pod.UID)}}}}}, nil
			})
			handler := c.Handler()
			send := func(body []byte) int {
				r := httptest.NewRequest("PUT", "/internal/scans/"+pod.Name, bytes.NewReader(gzipTestBytes(t, body)))
				r.Header.Set("Content-Type", "application/vnd.cyclonedx+json")
				r.Header.Set("Content-Encoding", "gzip")
				r.Header.Set("Authorization", "Bearer bound")
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, r)
				return w.Code
			}
			static, err := imageanalysis.MergeCycloneDX(nil, mergedTestReport(), "pending")
			if err != nil {
				t.Fatal(err)
			}
			if code := send(static); code != 201 {
				t.Fatalf("static upload HTTP %d", code)
			}
			if available, err := c.artifactExists(key); err != nil || available {
				t.Fatalf("static evidence satisfied vulnerability scan: %v %v", available, err)
			}
			if err := c.reconcile(ctx, image.GetName()); err != nil {
				t.Fatal(err)
			}
			if readState(t, c).Attempts[0].Outcome != "" {
				t.Fatal("static upload marked attempt succeeded")
			}
			// A restarted operator must reconstruct the pending status from disk.
			restarted := &Controller{Config: c.Config}
			if available, err := restarted.artifactExists(key); err != nil || available {
				t.Fatalf("restart promoted static-only evidence: %v %v", available, err)
			}
			if trivySucceeds {
				annotated, err := AnnotateArtifact([]byte(`{"bomFormat":"CycloneDX","specVersion":"1.6","version":1,"components":[]}`), "db-v1", "")
				if err != nil {
					t.Fatal(err)
				}
				merged, err := imageanalysis.MergeCycloneDX(annotated, mergedTestReport(), "complete")
				if err != nil {
					t.Fatal(err)
				}
				if code := send(merged); code != 201 {
					t.Fatalf("merged upload HTTP %d", code)
				}
				if err := c.reconcile(ctx, image.GetName()); err != nil {
					t.Fatal(err)
				}
				if readState(t, c).Attempts[0].Outcome != "succeeded" {
					t.Fatal("full artifact did not complete attempt")
				}
				// Retried early-phase uploads must not replace a completed scan.
				if code := send(static); code != 201 {
					t.Fatal(code)
				}
				if available, err := c.artifactExists(key); err != nil || !available {
					t.Fatalf("late static upload downgraded final artifact: %v %v", available, err)
				}
			} else {
				pod.Status.Phase = corev1.PodFailed
				pod.Status.InitContainerStatuses = []corev1.ContainerStatus{{Name: "trivy", State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ExitCode: 1, Message: "Trivy failed"}}}}
				_, _ = c.Kube.CoreV1().Pods("test").UpdateStatus(ctx, pod, metav1.UpdateOptions{})
				if err := c.observe(ctx, image, "sha256:target", key); err != nil {
					t.Fatal(err)
				}
				summary, err := readArtifactSummary(filepath.Join(c.Config.CacheDir, key+artifactSuffix))
				if err != nil || summary.Status != "failed" {
					t.Fatalf("failure missing from merged artifact: %+v %v", summary, err)
				}
				if summary.Coverage != "unknown" {
					t.Fatal("failed Trivy claimed known vulnerability coverage")
				}
			}
			files, err := os.ReadDir(c.Config.CacheDir)
			if err != nil {
				t.Fatal(err)
			}
			if len(files) != 1 || files[0].Name() != key+artifactSuffix {
				t.Fatalf("duplicate filesystem artifact retained: %v", files)
			}
			f, err := os.Open(filepath.Join(c.Config.CacheDir, key+artifactSuffix))
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			r, err := gzip.NewReader(f)
			if err != nil {
				t.Fatal(err)
			}
			defer r.Close()
			report, err := imageanalysis.ReadCycloneDX(r)
			if err != nil || report.LatestFilePath != "/server" || len(report.Binaries) != 1 {
				t.Fatalf("static evidence lost: %+v %v", report, err)
			}
			current, _ := c.Dynamic.Resource(images).Get(ctx, image.GetName(), metav1.GetOptions{})
			if current.GetAnnotations()["driftmower.io/analysis-"+Key("sha256:target", "manifest")[:40]] != key {
				t.Fatal("missing merged filesystem reference")
			}
		})
	}
}

func TestMergedUploadRejectsInvalidBoundedEvidence(t *testing.T) {
	body, err := imageanalysis.MergeCycloneDX(nil, mergedTestReport(), "pending")
	if err != nil {
		t.Fatal(err)
	}
	var root map[string]json.RawMessage
	_ = json.Unmarshal(body, &root)
	var p []imageanalysis.Property
	_ = json.Unmarshal(root["properties"], &p)
	for i := range p {
		if p[i].Name == "driftmower:filesystem:newest-file-limit" {
			p[i].Value = "1001"
		}
	}
	root["properties"], _ = json.Marshal(p)
	bad, _ := json.Marshal(root)
	if _, err := imageanalysis.ReadCycloneDX(bytes.NewReader(bad)); err == nil {
		t.Fatal("invalid filesystem evidence accepted")
	}
}
