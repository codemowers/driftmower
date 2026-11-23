package observability

import (
	"context"

	"net/url"
	"strings"
	"testing"
	"time"
)

func TestOutdatedWorkloadsUsesBoundedInstantQueryAndPreservesUnknownCoverage(t *testing.T) {
	available := true
	b := &fakeBackend{respond: func(u *url.URL) (Response, error) {
		q := u.Query()
		if u.Path != "/api/v1/query" || q.Get("limit") != "7" || !strings.Contains(q.Get("query"), "topk(5, topk by (namespace,uid)") || !strings.Contains(q.Get("query"), `namespace=~"team"`) {
			t.Fatalf("unbounded current query %s", u)
		}
		rows := []any{}
		if available {
			rows = append(rows, map[string]any{"metric": map[string]string{"signal": "coverage"}, "value": []any{fixedT.Unix(), "1"}}, map[string]any{"metric": map[string]string{"namespace": "team", "uid": "u1", "kind": "Deployment", "workload": "api", "version": "1.0", "latest": "2.0", "class": "major"}, "value": []any{fixedT.Unix(), "12"}})
		}
		return jsonBody(map[string]any{"status": "success", "data": map[string]any{"resultType": "vector", "result": rows}}), nil
	}}
	s := &Service{PrometheusURL: "http://history", Backend: b, Judge: &judge{}, Now: func() time.Time { return fixedT }}
	out, err := s.OutdatedWorkloads(context.Background(), alice, OutdatedWorkloadsInput{Namespaces: []string{"team"}})
	if err != nil || !out.Available || len(out.Entries) != 1 || out.Entries[0].ReleasesBehind != 12 {
		t.Fatalf("invalid top workload %+v %v", out, err)
	}
	available = false
	out, err = s.OutdatedWorkloads(context.Background(), alice, OutdatedWorkloadsInput{Namespaces: []string{"team"}})
	if err != nil || out.Available || len(out.Entries) != 0 {
		t.Fatalf("missing coverage looked clean %+v %v", out, err)
	}
	s.Judge = &judge{answer: deny}
	if _, err := s.OutdatedWorkloads(context.Background(), alice, OutdatedWorkloadsInput{Namespaces: []string{"team"}}); err == nil {
		t.Fatal("unauthorized current query accepted")
	}
	if b.calls() != 2 {
		t.Fatal("unauthorized query reached backend")
	}
}
