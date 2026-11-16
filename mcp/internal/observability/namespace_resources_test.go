package observability

import (
	"context"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestNamespaceResourcesFillsEachFigure(t *testing.T) {
	b := &fakeBackend{respond: func(u *url.URL) (Response, error) {
		q := u.Query().Get("query")
		value := map[string]string{
			"minio_bucket_usage_total_bytes": "300",
			`resource="memory"`:              "512",
			`kube_resourcequota{namespace="team",type="hard",resource=~"limits\\.cpu"}`: "4",
		}
		for needle, v := range value {
			if strings.Contains(q, needle) {
				if strings.HasPrefix(q, "count(") {
					v = "2"
				}

				return vectorOf(map[string]any{"metric": map[string]string{}, "value": []any{1, v}}), nil
			}
		}

		return vectorOf(), nil
	}}
	svc := &Service{PrometheusURL: "http://prometheus", Backend: b, Judge: &judge{}, Now: func() time.Time { return usageT }}
	r, err := svc.NamespaceResources(context.Background(), alice, "team")
	if err != nil {
		t.Fatal(err)
	}
	if r.Buckets.Count != 2 || *r.Buckets.Usage != 300 || r.Buckets.Requests != nil {
		t.Fatalf("buckets %+v", r.Buckets)
	}
	if *r.CPU.QuotaLimits != 4 || r.CPU.QuotaRequests != nil || *r.Memory.Requests != 512 || *r.Memory.Limits != 512 || r.Memory.Usage != nil {
		t.Fatalf("cpu %+v memory %+v", r.CPU, r.Memory)
	}
	if !strings.Contains(r.Queries["buckets.usage"], `bucket=~"team\\..+"`) {
		t.Fatalf("bucket selector %s", r.Queries["buckets.usage"])
	}
}

func TestNamespaceResourcesRequireListPods(t *testing.T) {
	svc := &Service{PrometheusURL: "http://prometheus", Backend: &fakeBackend{}, Judge: &judge{answer: deny}, Now: func() time.Time { return usageT }}
	if _, err := svc.NamespaceResources(context.Background(), alice, "team"); err == nil {
		t.Fatal("namespace resources read without list pods")
	}
}
