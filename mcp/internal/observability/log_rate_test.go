package observability

import (
	"context"
	"github.com/codemowers/driftmower/mcp/internal/authz"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestLogRateAggregatesInLoki(t *testing.T) {
	for _, tc := range []struct {
		name, pod, want string
		pods            []string
	}{
		{name: "namespace", want: `sum(rate({namespace="team"}[5m]))`},
		{name: "pod", pod: "api-1", want: `sum(rate({namespace="team",pod="api-1"}[5m]))`},
		{name: "workload", pods: []string{"api.1", "api-2"}, want: `sum(rate({namespace="team",pod=~"api\\.1|api-2"}[5m]))`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := &fakeBackend{respond: func(u *url.URL) (Response, error) {
				if u.Host != "loki" || u.Path != "/loki/api/v1/query" || u.Query().Get("query") != tc.want {
					t.Errorf("unexpected Loki request %s", u)
				}
				return vectorOf(map[string]any{"metric": map[string]string{}, "value": []any{60, "2.5"}}), nil
			}}
			svc := &Service{LokiURL: "http://loki", Backend: b, Judge: &judge{}, Now: func() time.Time { return usageT }}
			r, err := svc.LogRate(context.Background(), alice, "team", tc.pod, tc.pods...)
			if err != nil {
				t.Fatal(err)
			}
			if r.LinesPerSecond == nil || *r.LinesPerSecond != 2.5 || r.Query != tc.want {
				t.Fatalf("rate %+v", r)
			}
		})
	}
}

func TestLogRateDistinguishesMissingZeroAndInvalidSamples(t *testing.T) {
	for _, tc := range []struct {
		name               string
		rows               []map[string]any
		wantError, missing bool
	}{
		{name: "missing", missing: true},
		{name: "zero", rows: []map[string]any{map[string]any{"metric": map[string]string{}, "value": []any{60, "0"}}}},
		{name: "unaggregated", rows: []map[string]any{map[string]any{"metric": map[string]string{"pod": "other"}, "value": []any{60, "2"}}}, wantError: true},
		{name: "invalid", rows: []map[string]any{map[string]any{"metric": map[string]string{}, "value": []any{60, "NaN"}}}, wantError: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := &fakeBackend{respond: func(*url.URL) (Response, error) { return vectorOf(tc.rows...), nil }}
			svc := &Service{LokiURL: "http://loki", Backend: b, Judge: &judge{}, Now: func() time.Time { return usageT }}
			r, err := svc.LogRate(context.Background(), alice, "team", "")
			if (err != nil) != tc.wantError {
				t.Fatalf("error %v", err)
			}
			if err == nil && (r.LinesPerSecond == nil) != tc.missing {
				t.Fatalf("missing sample: %+v", r)
			}
		})
	}
}

func TestLogRateRequiresLogAccess(t *testing.T) {
	b := &fakeBackend{respond: func(*url.URL) (Response, error) { t.Fatal("read Loki without log access"); return vectorOf(), nil }}
	deny := &judge{answer: func(_ authz.Identity, a authz.Attributes) authz.Verdict {
		if a.Subresource == "log" {
			return authz.No
		}
		return authz.Yes
	}}
	svc := &Service{LokiURL: "http://loki", Backend: b, Judge: deny, Now: func() time.Time { return usageT }}
	for _, pod := range []string{"", "api-1"} {
		if _, err := svc.LogRate(context.Background(), alice, "team", pod); err == nil {
			t.Fatal("log access not checked")
		}
	}
	if _, err := svc.LogRate(context.Background(), alice, "team", "api-1", "api-2"); err == nil {
		t.Fatal("ambiguous selector accepted")
	}
}

func TestNamespaceSummariesSkipUnauthorizedNamespaces(t *testing.T) {
	b := &fakeBackend{respond: func(u *url.URL) (Response, error) {
		q := u.Query().Get("query")
		value := "2.5"
		switch {
		case strings.HasPrefix(q, "count by"):
			if !strings.Contains(q, "resource_limits") || !strings.Contains(q, `"memory"`) {
				return vectorOf(), nil
			}
			value = "3"
		case strings.Contains(q, `resource="memory"`):
			value = "1024"
		}

		return vectorOf(
			map[string]any{"metric": map[string]string{"namespace": "team"}, "value": []any{1, value}},
			map[string]any{"metric": map[string]string{"namespace": "secret"}, "value": []any{1, "9"}},
		), nil
	}}
	deny := &judge{answer: func(_ authz.Identity, a authz.Attributes) authz.Verdict {
		if a.Namespace == "secret" {
			return authz.No
		}

		return authz.Yes
	}}
	svc := &Service{PrometheusURL: "http://prometheus", Backend: b, Judge: deny, Now: func() time.Time { return usageT }}
	r, err := svc.NamespaceSummaries(context.Background(), alice, []string{"team", "secret"})
	if err != nil {
		t.Fatal(err)
	}
	team := r.Namespaces["team"]
	if len(r.Namespaces) != 1 || team == nil || *team.CPURequests != 2.5 || *team.MemoryRequests != 1024 || team.Unset.MemoryLimits != 3 || team.Unset.CPURequests != 0 || len(r.Warnings) != 1 {
		t.Fatalf("%+v %+v", r, team)
	}
	for _, u := range b.urls {
		if !strings.Contains(u.Query().Get("query"), `namespace=~"team"`) {
			t.Fatalf("query %s", u.Query().Get("query"))
		}
	}
}
