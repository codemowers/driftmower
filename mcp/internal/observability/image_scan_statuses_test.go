package observability

import (
	"context"
	"net/url"
	"strings"
	"testing"

	"github.com/codemowers/driftmower/mcp/internal/authz"
)

func TestImageScanStatusesUsePrometheusAndDeduplicateAliases(t *testing.T) {
	index := "sha256:" + strings.Repeat("a", 64)
	digest := "sha256:" + strings.Repeat("b", 64)
	other := "sha256:" + strings.Repeat("c", 64)
	indexName := strings.Replace(index, "sha256:", "sha256-", 1)
	b := &fakeBackend{respond: func(u *url.URL) (Response, error) {
		query := u.Query().Get("query")
		if !strings.Contains(query, `driftmower_namespace="scans"`) || !strings.Contains(query, `driftmower_instance="test"`) || !strings.Contains(query, "driftmower:image_scan_state:max") {
			t.Fatalf("unscoped query %s", query)
		}
		return vectorOf(
			map[string]any{"metric": map[string]string{"digest": digest, "state": "done"}, "value": []any{1, "1"}},
			map[string]any{"metric": map[string]string{"image": indexName, "digest": digest, "state": "done"}, "value": []any{1, "1"}},
			map[string]any{"metric": map[string]string{"image": indexName, "digest": other, "state": "pending"}, "value": []any{1, "1"}},
		), nil
	}}
	s := &Service{PrometheusURL: "http://prom", Backend: b, Judge: &judge{}, ScannerNamespace: "scans", ScannerInstance: "test"}
	out, err := s.ImageScanStatuses(context.Background(), alice, []string{index, digest})
	if err != nil {
		t.Fatal(err)
	}
	if out.Images[digest].Status != "done" || out.Images[digest].Total != 1 {
		t.Fatalf("platform status %+v", out.Images[digest])
	}
	if out.Images[index].Status != "partial" || out.Images[index].Total != 2 || out.Images[index].Done != 1 {
		t.Fatalf("index status %+v", out.Images[index])
	}
	s.Judge = &judge{answer: func(authz.Identity, authz.Attributes) authz.Verdict { return authz.No }}
	if _, err := s.ImageScanStatuses(context.Background(), alice, []string{digest}); err == nil {
		t.Fatal("unauthorized scan status allowed")
	}
	if b.calls() != 1 {
		t.Fatal("Prometheus queried before authorization")
	}
}

func TestMissingScanMetricsAreUnavailableNotPending(t *testing.T) {
	b := &fakeBackend{respond: func(*url.URL) (Response, error) { return vectorOf(), nil }}
	s := &Service{PrometheusURL: "http://prom", Backend: b, Judge: &judge{}}
	digest := "sha256:" + strings.Repeat("a", 64)
	out, err := s.ImageScanStatuses(context.Background(), alice, []string{digest})
	if err != nil {
		t.Fatal(err)
	}
	if out.Images[digest].Status != "unavailable" {
		t.Fatal(out.Images[digest])
	}
}

func TestPartialJavaScanRemainsUsableAndExplained(t *testing.T) {
	digest := "sha256:" + strings.Repeat("a", 64)
	b := &fakeBackend{respond: func(*url.URL) (Response, error) {
		return vectorOf(map[string]any{"metric": map[string]string{"digest": digest, "state": "partial"}, "value": []any{1, "1"}}), nil
	}}
	s := &Service{PrometheusURL: "http://prom", Backend: b, Judge: &judge{}}
	out, err := s.ImageScanStatuses(context.Background(), alice, []string{digest})
	if err != nil {
		t.Fatal(err)
	}
	row := out.Images[digest]
	if row.Status != "partial" || row.Partial != 1 || !strings.Contains(row.Reason, "Java") {
		t.Fatalf("partial scan lost: %+v", row)
	}
}
