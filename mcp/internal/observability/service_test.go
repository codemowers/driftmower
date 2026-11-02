package observability

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/codemowers/driftmower/mcp/internal/authz"
)

var (
	alice  = authz.Identity{User: "https://auth.example/#alice", Groups: []string{"developers"}}
	fixedT = time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
)

// judge records the questions asked and answers through answer.
type judge struct {
	mu     sync.Mutex
	asked  []authz.Attributes
	who    []string
	answer func(authz.Identity, authz.Attributes) authz.Verdict
}

func (j *judge) MayPerform(_ context.Context, id authz.Identity, a authz.Attributes) authz.Judgement {
	j.mu.Lock()
	j.asked = append(j.asked, a)
	j.who = append(j.who, id.User)
	answer := j.answer
	j.mu.Unlock()
	if answer == nil {
		return authz.Judgement{Verdict: authz.Yes}
	}

	return authz.Judgement{Verdict: answer(id, a)}
}

func deny(authz.Identity, authz.Attributes) authz.Verdict { return authz.No }

func jsonBody(v any) Response {
	b, _ := json.Marshal(v)

	return Response{Status: 200, Body: b}
}

func emptyVector() Response {
	return jsonBody(map[string]any{"status": "success", "data": map[string]any{"resultType": "vector", "result": []any{}}})
}

type serviceFixture struct {
	svc     *Service
	judge   *judge
	backend *fakeBackend
	kube    *fake.Clientset
	logOpts *corev1.PodLogOptions
	logs    string
}

func newService(loki bool) *serviceFixture {
	f := &serviceFixture{judge: &judge{}, kube: fake.NewClientset(), logs: "2026-09-25T11:55:00.123456789Z hello\n"}
	f.backend = &fakeBackend{respond: func(*url.URL) (Response, error) { return emptyVector(), nil }}
	f.kube.PrependReactor("get", "pods", func(a k8stesting.Action) (bool, runtime.Object, error) {
		if a.GetSubresource() != "log" {
			return false, nil, nil
		}
		f.logOpts = a.(k8stesting.GenericAction).GetValue().(*corev1.PodLogOptions)

		return true, &runtime.Unknown{Raw: []byte(f.logs)}, nil
	})
	f.svc = &Service{PrometheusURL: "http://prometheus:9090", Backend: f.backend, Kubernetes: f.kube, Judge: f.judge,
		Now: func() time.Time { return fixedT }}
	if loki {
		f.svc.LokiURL = "http://loki:3100"
	}

	return f
}

var metric = MetricsInput{Namespace: "team-a", Metric: "container_cpu_usage_seconds_total"}
var logsIn = LogsInput{Namespace: "team-a", Pod: "api-1", Container: "api"}

func TestMetricsAuthorization(t *testing.T) {
	f := newService(true)
	if _, err := f.svc.QueryMetrics(context.Background(), alice, metric); err != nil {
		t.Fatal(err)
	}
	if len(f.judge.asked) != 1 || f.judge.asked[0] != (authz.Attributes{Namespace: "team-a", Resource: "pods", Verb: "list"}) {
		t.Errorf("asked = %+v", f.judge.asked)
	}
	if f.backend.calls() != 1 {
		t.Errorf("calls = %d", f.backend.calls())
	}
}

func TestLogsAuthorizationChecksExactPodLog(t *testing.T) {
	f := newService(false)
	if _, err := f.svc.QueryLogs(context.Background(), alice, logsIn); err != nil {
		t.Fatal(err)
	}
	want := authz.Attributes{Namespace: "team-a", Resource: "pods", Subresource: "log", Name: "api-1", Verb: "get"}
	if len(f.judge.asked) != 1 || f.judge.asked[0] != want {
		t.Errorf("asked = %+v", f.judge.asked)
	}
	if f.logOpts == nil {
		t.Error("pod logs were not read")
	}
}

func TestFailsClosedForBothSources(t *testing.T) {
	for _, v := range []authz.Verdict{authz.No, authz.Unknown} {
		f := newService(false)
		f.judge.answer = func(authz.Identity, authz.Attributes) authz.Verdict { return v }
		if _, err := f.svc.QueryMetrics(context.Background(), alice, metric); err == nil {
			t.Errorf("%s: metrics allowed", v)
		}
		if _, err := f.svc.QueryLogs(context.Background(), alice, logsIn); err == nil {
			t.Errorf("%s: logs allowed", v)
		}
		if f.backend.calls() != 0 || f.logOpts != nil {
			t.Errorf("%s: a backend was contacted", v)
		}
	}

	f := newService(true)
	f.judge.answer = deny
	if _, err := f.svc.QueryLogs(context.Background(), alice, logsIn); err == nil || !strings.Contains(err.Error(), "RBAC denied") {
		t.Errorf("err = %v", err)
	}
	if f.backend.calls() != 0 {
		t.Error("Loki contacted after a denial")
	}
}

func TestAuthorizationNotReusedAcrossCallers(t *testing.T) {
	f := newService(true)
	f.judge.answer = func(id authz.Identity, _ authz.Attributes) authz.Verdict {
		if id.User == alice.User {
			return authz.Yes
		}

		return authz.No
	}
	_, errA := f.svc.QueryMetrics(context.Background(), alice, metric)
	other := metric
	other.Namespace = "team-b"
	_, errB := f.svc.QueryMetrics(context.Background(), authz.Identity{User: "bob"}, other)
	if errA != nil || errB == nil || len(f.judge.asked) != 2 || f.backend.calls() != 1 {
		t.Errorf("alice %v, bob %v, asked %d, calls %d", errA, errB, len(f.judge.asked), f.backend.calls())
	}
}

func TestScopedRangeQuery(t *testing.T) {
	f := newService(true)
	in := metric
	in.Operation, in.WindowSeconds, in.Aggregate, in.GroupBy = "rate", 300, "sum", []string{"pod"}
	in.Labels = map[string]string{"container": "api"}
	in.Start, in.End = "2026-09-25T11:00:00Z", "2026-09-25T12:00:00Z"
	if _, err := f.svc.QueryMetrics(context.Background(), alice, in); err != nil {
		t.Fatal(err)
	}
	u := f.backend.urls[0]
	q := u.Query()
	if u.Path != "/api/v1/query_range" ||
		q.Get("query") != `sum by (namespace,pod) (rate(container_cpu_usage_seconds_total{namespace="team-a",container="api"}[300s]))` ||
		q.Get("step") != "60" || q.Get("limit") != "100" {
		t.Errorf("url = %s", u)
	}
}

func TestLabelValuesAreLiterals(t *testing.T) {
	f := newService(true)
	injection := "\"} or up{namespace=\"other\"}\n\\"
	in := metric
	in.Labels = map[string]string{"pod": injection}
	if _, err := f.svc.QueryMetrics(context.Background(), alice, in); err != nil {
		t.Fatal(err)
	}
	quoted, _ := json.Marshal(injection)
	want := `container_cpu_usage_seconds_total{namespace="team-a",pod=` + string(quoted) + `}`
	if got := f.backend.urls[0].Query().Get("query"); got != want {
		t.Errorf("query = %s\nwant %s", got, want)
	}
}

func TestRejectsUnsafeOrUnboundedMetricInputs(t *testing.T) {
	cases := map[string]func(*MetricsInput){
		"metric expression": func(m *MetricsInput) { m.Metric = "up or secret" },
		"namespace regex":   func(m *MetricsInput) { m.Namespace = ".*" },
		"namespace label":   func(m *MetricsInput) { m.Labels = map[string]string{"namespace": "other"} },
		"__name__ label":    func(m *MetricsInput) { m.Labels = map[string]string{"__name__": "secret"} },
		"label operator":    func(m *MetricsInput) { m.Labels = map[string]string{"pod=~": ".*"} },
		"groupBy injection": func(m *MetricsInput) { m.Aggregate, m.GroupBy = "sum", []string{"pod) (up)"} },
		"start only":        func(m *MetricsInput) { m.Start = "2026-09-25T11:00:00Z" },
		"over seven days":   func(m *MetricsInput) { m.Start, m.End = "2026-09-01T00:00:00Z", "2026-09-25T00:00:00Z" },
		"negative range":    func(m *MetricsInput) { m.Start, m.End = "2026-09-25T00:00:00Z", "2026-09-24T00:00:00Z" },
		"limit":             func(m *MetricsInput) { m.Limit = 1001 },
		"groupBy alone":     func(m *MetricsInput) { m.GroupBy = []string{"pod"} },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			f := newService(true)
			in := metric
			mutate(&in)
			if _, err := f.svc.QueryMetrics(context.Background(), alice, in); err == nil {
				t.Error("accepted")
			}
			if len(f.judge.asked) != 0 || f.backend.calls() != 0 {
				t.Errorf("asked %d, calls %d before validation", len(f.judge.asked), f.backend.calls())
			}
		})
	}
}

func vectorOf(series ...map[string]any) Response {
	return jsonBody(map[string]any{"status": "success", "data": map[string]any{"resultType": "vector", "result": series}})
}

func TestMetricsNamespaceConfinementAndWarnings(t *testing.T) {
	f := newService(true)
	f.backend.respond = func(*url.URL) (Response, error) {
		return vectorOf(map[string]any{"metric": map[string]string{"namespace": "other"}, "value": []any{1, "42"}}), nil
	}
	if _, err := f.svc.QueryMetrics(context.Background(), alice, metric); err == nil || !strings.Contains(err.Error(), "outside the requested namespace") {
		t.Errorf("err = %v", err)
	}

	f.backend.respond = func(*url.URL) (Response, error) {
		r := jsonBody(map[string]any{"status": "success", "warnings": []string{"partial data"},
			"data": map[string]any{"resultType": "vector", "result": []any{map[string]any{"metric": map[string]string{"namespace": "team-a"}, "value": []any{1, "42"}}}}})

		return r, nil
	}
	res, err := f.svc.QueryMetrics(context.Background(), alice, metric)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(res.Result)
	if string(raw) != `[{"metric":{"namespace":"team-a"},"value":[1,"42"]}]` || len(res.Warnings) != 1 || res.Warnings[0] != "partial data" {
		t.Errorf("result = %s, warnings %v", raw, res.Warnings)
	}
}

func lokiStreams(streams ...map[string]any) Response {
	return jsonBody(map[string]any{"status": "success", "data": map[string]any{"resultType": "streams", "result": streams}})
}

func TestLokiQuery(t *testing.T) {
	f := newService(true)
	stream := map[string]any{"stream": map[string]string{"namespace": "team-a", "pod": "api-1", "container": "api"},
		"values": []any{[]any{"1790337300000000000", "hello"}}}
	f.backend.respond = func(*url.URL) (Response, error) { return lokiStreams(stream), nil }
	in := logsIn
	in.Contains = `" or {namespace="other"}`
	res, err := f.svc.QueryLogs(context.Background(), alice, in)
	if err != nil {
		t.Fatal(err)
	}
	if res.Source != "loki" || len(res.Streams) != 1 {
		t.Errorf("result = %+v", res)
	}
	u := f.backend.urls[0]
	contains, _ := json.Marshal(in.Contains)
	if u.Path != "/loki/api/v1/query_range" ||
		u.Query().Get("query") != `{namespace="team-a",pod="api-1",container="api"} |= `+string(contains) ||
		u.Query().Get("end") != strconv.FormatInt(fixedT.UnixMilli(), 10)+"000000" ||
		u.Query().Get("direction") != "backward" {
		t.Errorf("url = %s", u)
	}
	if f.logOpts != nil {
		t.Error("Kubernetes logs read while Loki is configured")
	}
}

func TestLokiFailuresDoNotSwitchSources(t *testing.T) {
	for _, status := range []int{400, 401, 403, 429, 500, 503} {
		f := newService(true)
		f.backend.respond = func(*url.URL) (Response, error) { return Response{Status: status}, nil }
		if _, err := f.svc.QueryLogs(context.Background(), alice, logsIn); err == nil || err.Error() != "Loki returned HTTP "+strconv.Itoa(status) {
			t.Errorf("%d: err = %v", status, err)
		}
		if f.logOpts != nil {
			t.Errorf("%d: switched to Kubernetes logs", status)
		}
	}

	f := newService(true)
	f.backend.respond = func(*url.URL) (Response, error) { return Response{}, errors.New("timeout") }
	if _, err := f.svc.QueryLogs(context.Background(), alice, logsIn); err == nil || !strings.Contains(err.Error(), "timeout") {
		t.Errorf("err = %v", err)
	}
	f.backend.respond = func(*url.URL) (Response, error) { return Response{Status: 200, Body: []byte("invalid")}, nil }
	if _, err := f.svc.QueryLogs(context.Background(), alice, logsIn); err == nil {
		t.Error("malformed response accepted")
	}
	f.backend.respond = func(*url.URL) (Response, error) { return lokiStreams(), nil }
	if res, err := f.svc.QueryLogs(context.Background(), alice, logsIn); err != nil || res.Source != "loki" || len(res.Streams) != 0 {
		t.Errorf("empty = %+v %v", res, err)
	}
	if f.logOpts != nil {
		t.Error("switched to Kubernetes logs")
	}

	f.backend.respond = func(*url.URL) (Response, error) {
		return lokiStreams(map[string]any{"stream": map[string]string{"namespace": "other", "pod": "api-1", "container": "api"}, "values": []any{}}), nil
	}
	if _, err := f.svc.QueryLogs(context.Background(), alice, logsIn); err == nil || !strings.Contains(err.Error(), "outside the requested scope") {
		t.Errorf("err = %v", err)
	}
}

func TestKubernetesLogsWhenLokiUnset(t *testing.T) {
	f := newService(false)
	f.logs = strings.Join([]string{
		"2026-09-25T10:00:00Z too old",
		"2026-09-25T11:50:00.123456789Z hello first",
		"2026-09-25T11:55:00Z goodbye",
		"2026-09-25T11:59:00Z hello last",
		"2026-09-25T12:01:00Z hello too new",
		"",
	}, "\n")
	in := logsIn
	in.Contains, in.Limit = "hello", 25
	res, err := f.svc.QueryLogs(context.Background(), alice, in)
	if err != nil {
		t.Fatal(err)
	}
	want := []LogEntry{{"2026-09-25T11:59:00Z", "hello last"}, {"2026-09-25T11:50:00.123456789Z", "hello first"}}
	if res.Source != "kubernetes" || len(res.Entries) != 2 || res.Entries[0] != want[0] || res.Entries[1] != want[1] {
		t.Errorf("entries = %+v", res.Entries)
	}
	o := f.logOpts
	if !o.Timestamps || !o.SinceTime.Time.Equal(fixedT.Add(-time.Hour)) || *o.TailLines != 25 || *o.LimitBytes != 1<<20 || o.Container != "api" || o.Follow {
		t.Errorf("options = %+v", o)
	}
	if f.backend.calls() != 0 {
		t.Error("backend contacted")
	}
}
