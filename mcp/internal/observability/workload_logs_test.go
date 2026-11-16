package observability

import (
	"context"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/codemowers/driftmower/mcp/internal/authz"
)

func livePod(name string, containers ...string) *corev1.Pod {
	p := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "team", Name: name}}
	for _, c := range containers {
		p.Spec.Containers = append(p.Spec.Containers, corev1.Container{Name: c})
	}

	return p
}

func stream(labels map[string]string, values ...[]any) map[string]any {
	return map[string]any{"stream": labels, "values": values}
}

// lokiFixture answers series queries from streams and query_range with
// lines for every stream the query selects.
func lokiFixture(t *testing.T, streams []map[string]string, pods ...*corev1.Pod) (*Service, *[]string) {
	t.Helper()
	var queries []string
	selects := func(selector string, labels map[string]string) bool {
		for _, part := range strings.Split(strings.Trim(selector, "{}"), ",") {
			if k, v, ok := strings.Cut(part, "=~"); ok {
				names := strings.Split(strings.ReplaceAll(strings.Trim(v, `"`), `\\`, `\`), "|")
				for i := range names {
					names[i] = strings.ReplaceAll(names[i], `\.`, ".")
				}
				if !slices.Contains(names, labels[k]) {
					return false
				}

				continue
			}
			k, v, _ := strings.Cut(part, "=")
			if labels[k] != strings.Trim(v, `"`) {
				return false
			}
		}

		return true
	}
	b := &fakeBackend{respond: func(u *url.URL) (Response, error) {
		q := u.Query()
		switch {
		case strings.HasSuffix(u.Path, "/series"):
			out := []map[string]string{}
			for _, s := range streams {
				if selects(q.Get("match[]"), s) {
					out = append(out, s)
				}
			}

			return jsonBody(map[string]any{"status": "success", "data": out}), nil
		default:
			queries = append(queries, q.Get("query"))
			out := []map[string]any{}
			for i, s := range streams {
				if selects(strings.SplitN(q.Get("query"), " ", 2)[0], s) {
					out = append(out, stream(s, []any{"10000000000000000" + string(rune('0'+i)), s["pod"] + " line"}))
				}
			}

			return jsonBody(map[string]any{"status": "success", "data": map[string]any{"resultType": "streams", "result": out}}), nil
		}
	}}
	k := fake.NewClientset()
	for _, p := range pods {
		_, _ = k.CoreV1().Pods("team").Create(context.Background(), p, metav1.CreateOptions{})
	}

	return &Service{LokiURL: "http://loki", LogsEnabled: true, Backend: b, Kubernetes: k, Judge: &judge{}, Now: func() time.Time { return usageT }}, &queries
}

func TestWorkloadLogsUseSharedLabelsWhenUnique(t *testing.T) {
	streams := []map[string]string{
		{"namespace": "team", "pod": "api-1", "container": "api", "app": "api", "job": "team/api"},
		{"namespace": "team", "pod": "api-2", "container": "api", "app": "api", "job": "team/api"},
		// A replaced Pod of the same workload.
		{"namespace": "team", "pod": "api-0", "container": "api", "app": "api", "job": "team/api"},
		{"namespace": "team", "pod": "db-0", "container": "db", "app": "db", "job": "team/db"},
	}
	svc, queries := lokiFixture(t, streams, livePod("api-1", "api"), livePod("api-2", "api"), livePod("db-0", "db"))
	r, err := svc.WorkloadLogs(context.Background(), alice, WorkloadLogsInput{Namespace: "team", Name: "api", Pods: []string{"api-1", "api-2"}})
	if err != nil {
		t.Fatal(err)
	}
	if r.Selector != "labels" || (*queries)[0] != `{app="api",job="team/api",namespace="team"}` {
		t.Fatalf("selector %s, query %q", r.Selector, (*queries)[0])
	}
	var pods []string
	for _, e := range r.Entries {
		pods = append(pods, e.Pod)
	}
	if !slices.Equal(pods, []string{"api-1", "api-2", "api-0"}) || !slices.Equal(r.Containers, []string{"api"}) {
		t.Fatalf("entries from %v, containers %v", pods, r.Containers)
	}
}

func TestWorkloadLogsFallBackToPodsWhenLabelsReachAnotherWorkload(t *testing.T) {
	streams := []map[string]string{
		{"namespace": "team", "pod": "api-1", "container": "api", "app": "shared"},
		{"namespace": "team", "pod": "worker-1", "container": "worker", "app": "shared"},
	}
	svc, queries := lokiFixture(t, streams, livePod("api-1", "api"), livePod("worker-1", "worker"))
	r, err := svc.WorkloadLogs(context.Background(), alice, WorkloadLogsInput{Namespace: "team", Name: "api", Pods: []string{"api-1"}})
	if err != nil {
		t.Fatal(err)
	}
	if r.Selector != "pods" || (*queries)[0] != `{namespace="team",pod=~"api-1"}` || len(r.Entries) != 1 {
		t.Fatalf("selector %s, query %q, entries %+v", r.Selector, (*queries)[0], r.Entries)
	}
}

func TestWorkloadLogsWithoutNamespaceLogAccessUsePods(t *testing.T) {
	streams := []map[string]string{{"namespace": "team", "pod": "api-1", "container": "api", "app": "api"}}
	svc, queries := lokiFixture(t, streams, livePod("api-1", "api"))
	svc.Judge = &judge{answer: func(_ authz.Identity, a authz.Attributes) authz.Verdict {
		if a.Name == "" {
			return authz.No
		}

		return authz.Yes
	}}
	r, err := svc.WorkloadLogs(context.Background(), alice, WorkloadLogsInput{Namespace: "team", Name: "api", Pods: []string{"api-1"}})
	if err != nil {
		t.Fatal(err)
	}
	if r.Selector != "pods" || (*queries)[0] != `{namespace="team",pod=~"api-1"}` {
		t.Fatalf("selector %s, query %q", r.Selector, (*queries)[0])
	}
}

func TestWorkloadLogsRequirePodLogAccess(t *testing.T) {
	svc, _ := lokiFixture(t, nil, livePod("api-1", "api"))
	svc.Judge = &judge{answer: deny}
	if _, err := svc.WorkloadLogs(context.Background(), alice, WorkloadLogsInput{Namespace: "team", Name: "api", Pods: []string{"api-1"}}); err == nil {
		t.Fatal("logs read without pods/log permission")
	}
}

func TestNewestInOrderKeepsTheNewestOldestFirst(t *testing.T) {
	got := newestInOrder([]WorkloadLogEntry{{TsNs: "30", Line: "c"}, {TsNs: "10", Line: "a"}, {TsNs: "20", Line: "b"}}, 2)
	if len(got) != 2 || got[0].Line != "b" || got[1].Line != "c" {
		t.Fatalf("got %+v", got)
	}
}

func TestNamespaceLogsSelectEveryPodAndNeedNamespaceAccess(t *testing.T) {
	streams := []map[string]string{
		{"namespace": "team", "pod": "api-1", "container": "api"},
		{"namespace": "team", "pod": "db-0", "container": "db"},
	}
	svc, queries := lokiFixture(t, streams, livePod("api-1", "api"), livePod("db-0", "db"))
	r, err := svc.WorkloadLogs(context.Background(), alice, WorkloadLogsInput{Namespace: "team", WholeNamespace: true})
	if err != nil {
		t.Fatal(err)
	}
	if r.Selector != "namespace" || (*queries)[0] != `{namespace="team"}` || len(r.Entries) != 2 || !slices.Equal(r.Containers, []string{"api", "db"}) {
		t.Fatalf("selector %s, query %q, result %+v", r.Selector, (*queries)[0], r)
	}
	svc.Judge = &judge{answer: func(_ authz.Identity, a authz.Attributes) authz.Verdict {
		if a.Name == "" {
			return authz.No
		}

		return authz.Yes
	}}
	if _, err := svc.WorkloadLogs(context.Background(), alice, WorkloadLogsInput{Namespace: "team", WholeNamespace: true}); err == nil {
		t.Fatal("namespace logs read without namespace-wide pods/log")
	}
}
