package scanner

import (
	"bytes"
	"context"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/prometheus/common/expfmt"
	"github.com/prometheus/common/model"
	authv1 "k8s.io/api/authentication/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes/fake"
	ktesting "k8s.io/client-go/testing"
)

func TestSBOMSizeReportsRequireBoundTokenAndClearAfterUpload(t *testing.T) {
	c, image, key := testController(t, 1)
	c.Config.MaxBytes = 64 << 20
	c.Config.Audience = "scan-tests"
	if err := dispatchTest(t, c, image, key); err != nil {
		t.Fatal(err)
	}
	pod := currentPod(t, c)
	pod.UID = types.UID("scan-pod-uid")
	if pod.Annotations["driftmower.io/platform-digest"] != "sha256:target" {
		t.Fatal("scan Pod lacks platform digest for diagnostics")
	}
	if _, err := c.Kube.CoreV1().Pods("test").Update(context.Background(), pod, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	c.Kube.(*fake.Clientset).PrependReactor("create", "tokenreviews", func(action ktesting.Action) (bool, runtime.Object, error) {
		review := action.(ktesting.CreateAction).GetObject().(*authv1.TokenReview)
		account := "driftmower-scan"
		if review.Spec.Token == "reader-token" {
			account = "driftmower-mcp"
		}
		return true, &authv1.TokenReview{Status: authv1.TokenReviewStatus{
			Authenticated: review.Spec.Token == "bound-token" || review.Spec.Token == "reader-token",
			Audiences:     []string{c.Config.Audience},
			User: authv1.UserInfo{
				Username: "system:serviceaccount:test:" + account,
				Extra: map[string]authv1.ExtraValue{
					"authentication.kubernetes.io/pod-name": {pod.Name},
					"authentication.kubernetes.io/pod-uid":  {string(pod.UID)},
				},
			},
		}}, nil
	})
	handler := c.Handler()
	for _, tc := range []struct {
		name, token, contentType, body string
		want                           int
	}{
		{"unauthenticated", "wrong", OversizedSBOMMediaType, `{"sizeBytes":40000000}`, 401},
		{"not oversized", "bound-token", OversizedSBOMMediaType, `{"sizeBytes":32}`, 400},
		{"trailing data", "bound-token", OversizedSBOMMediaType, `{"sizeBytes":40000000} {}`, 400},
		{"oversized", "bound-token", OversizedSBOMMediaType, `{"sizeBytes":40000000}`, 413},
		{"stream without size report", "bound-token", "application/vnd.cyclonedx+json", strings.Repeat(" ", MaxSBOMBytes+1), 413},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var body io.Reader = strings.NewReader(tc.body)
			if tc.contentType != OversizedSBOMMediaType {
				body = bytes.NewReader(gzipTestBytes(t, []byte(tc.body)))
			}
			req := httptest.NewRequest(http.MethodPut, "/internal/scans/"+pod.Name, body)
			if tc.contentType != OversizedSBOMMediaType {
				req.Header.Set("Content-Encoding", "gzip")
			}
			req.Header.Set("Authorization", "Bearer "+tc.token)
			req.Header.Set("Content-Type", tc.contentType)
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, req)
			if recorder.Code != tc.want {
				t.Fatalf("HTTP %d, want %d: %s", recorder.Code, tc.want, recorder.Body)
			}
		})
	}
	// Neither rejected authentication nor malformed size reports may create
	// observations. Both real oversize failures exceed the last finite bucket.
	scrape := httptest.NewRecorder()
	handler.ServeHTTP(scrape, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	parser := expfmt.NewTextParser(model.UTF8Validation)
	families, err := parser.TextToMetricFamilies(scrape.Body)
	if err != nil {
		t.Fatal(err)
	}
	histogram := families["driftmower_sbom_size_bytes"].Metric[0].GetHistogram()
	if histogram.GetSampleCount() != 2 || histogram.GetSampleSum() != 40000000+MaxSBOMBytes+1 {
		t.Fatalf("unexpected sizes: %v", histogram)
	}
	for _, bucket := range histogram.Bucket {
		if !math.IsInf(bucket.GetUpperBound(), 1) && bucket.GetCumulativeCount() != 0 {
			t.Fatalf("oversized result entered a finite bucket: %v", bucket)
		}
	}
	failure := families["driftmower_sbom_size_limit_exceeded_bytes"].Metric[0]
	labels := map[string]string{}
	for _, label := range failure.Label {
		labels[label.GetName()] = label.GetValue()
	}
	if labels["image"] != image.GetName() || labels["digest"] != "sha256:target" || failure.GetGauge().GetValue() != MaxSBOMBytes+1 {
		t.Fatalf("failure lacks image identity and size: %v", failure)
	}
	if exists, err := c.artifactExists(key); exists || err != nil {
		t.Fatalf("oversized artifact was cached: exists=%v, err=%v", exists, err)
	}
	// A later successful upload clears the warning for the same image/platform.
	encoded := gzipTestBytes(t, []byte(`{"bomFormat":"CycloneDX"}`+strings.Repeat(" ", 10000)))
	c.Config.MaxBytes = int64(len(encoded))
	req := httptest.NewRequest(http.MethodPut, "/internal/scans/"+pod.Name, bytes.NewReader(encoded))
	req.Header.Set("Content-Encoding", "gzip")
	req.Header.Set("Authorization", "Bearer bound-token")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("valid upload: %d %s", recorder.Code, recorder.Body)
	}
	stored, err := os.ReadFile(filepath.Join(c.Config.CacheDir, key+artifactSuffix))
	if err != nil || !bytes.Equal(stored, encoded) {
		t.Fatalf("cached gzip changed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(c.Config.CacheDir, key+".json")); !os.IsNotExist(err) {
		t.Fatal("plain JSON cache file exists")
	}
	read := func(method, encoding, etag string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, "/v1/sboms/"+key, nil)
		request.Header.Set("Authorization", "Bearer reader-token")
		request.Header.Set("Accept-Encoding", encoding)
		if etag != "" {
			request.Header.Set("If-None-Match", etag)
		}
		result := httptest.NewRecorder()
		handler.ServeHTTP(result, request)
		return result
	}
	download := read("GET", "gzip", "")
	if download.Code != 200 || download.Header().Get("Content-Encoding") != "gzip" || !bytes.Equal(download.Body.Bytes(), encoded) {
		t.Fatalf("gzip serving changed bytes: %d %s", download.Code, download.Body)
	}
	if conditional := read("GET", "gzip", download.Header().Get("ETag")); conditional.Code != 304 || conditional.Body.Len() != 0 {
		t.Fatal("gzip conditional read failed")
	}
	if incompatible := read("GET", "identity", ""); incompatible.Code != 406 {
		t.Fatal("gzip-only endpoint accepted identity")
	}
	plain := httptest.NewRequest(http.MethodPut, "/internal/scans/"+pod.Name, strings.NewReader(`{"bomFormat":"CycloneDX"}`))
	plain.Header.Set("Authorization", "Bearer bound-token")
	plainResult := httptest.NewRecorder()
	handler.ServeHTTP(plainResult, plain)
	if plainResult.Code != 415 {
		t.Fatal("plain JSON upload was accepted")
	}
	scrape = httptest.NewRecorder()
	handler.ServeHTTP(scrape, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if strings.Contains(scrape.Body.String(), "driftmower_sbom_size_limit_exceeded_bytes{") {
		t.Fatal("successful upload left the image's oversized warning active")
	}
	if !strings.Contains(scrape.Body.String(), "driftmower_sbom_size_bytes_count 3\n") {
		t.Fatal("successful upload was not measured")
	}
}
