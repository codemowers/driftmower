package observability

import (
	"context"
	"fmt"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestDriftHistoryRetriesEveryMetricAtSharedCoarserResolution(t *testing.T) {
	calls := []string{}
	backend := &fakeBackend{respond: func(u *url.URL) (Response, error) {
		q := u.Query()
		step, _ := strconv.Atoi(q.Get("step"))
		query := q.Get("query")
		calls = append(calls, q.Get("step")+query)
		if !strings.Contains(query, `namespace=~"team"`) || !strings.Contains(query, `workload="api"`) || !strings.HasPrefix(query, "max by (") {
			t.Fatalf("unscoped/duplicate-label query: %s", query)
		}
		if strings.Contains(query, "driftmower_version_status") && step == 21600 {
			return Response{}, fmt.Errorf("large result: %w", ErrResponseTooLarge)
		}
		return matrixOf(map[string]any{"metric": map[string]string{"namespace": "team", "uid": "u", "workload": "api"}, "values": []any{[]any{fixedT.Unix(), "1"}}}), nil
	}}
	s := &Service{PrometheusURL: "http://history", Backend: backend, Judge: &judge{}, Now: func() time.Time { return fixedT }}
	out, err := s.DriftHistory(context.Background(), alice, DriftHistoryInput{Namespaces: []string{"team"}, Workload: "api", Metrics: []string{"driftmower_version_releases_behind", "driftmower_version_status", "driftmower_version_container_count"}})
	if err != nil {
		t.Fatal(err)
	}
	if out.StepSeconds != 28800 || len(calls) != 5 || !strings.HasPrefix(calls[2], "28800") || len(out.Metrics) != 3 {
		t.Fatalf("mixed resolution after retry: %+v calls %v", out, calls)
	}
}
func TestDriftHistoryAuthorizationPrecedesAdaptiveRequests(t *testing.T) {
	b := &fakeBackend{respond: func(*url.URL) (Response, error) { t.Fatal("unauthorized backend read"); return Response{}, nil }}
	s := &Service{PrometheusURL: "http://history", Backend: b, Judge: &judge{answer: func(authz.Identity, authz.Attributes) authz.Verdict { return authz.No }}}
	if _, err := s.DriftHistory(context.Background(), alice, DriftHistoryInput{Namespaces: []string{"team"}}); err == nil {
		t.Fatal("unauthorized query accepted")
	}
}
