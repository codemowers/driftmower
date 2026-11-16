package observability

import (
	"context"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/codemowers/driftmower/mcp/internal/authz"
	"sigs.k8s.io/yaml"
)

func TestSignalHistoryAuthorizesEveryNamespaceAndBoundsResponse(t *testing.T) {
	b := &fakeBackend{respond: func(u *url.URL) (Response, error) {
		q := u.Query().Get("query")
		if u.Path != "/api/v1/query_range" || !strings.Contains(q, `namespace=~"team\\|secret"`) {
			t.Fatalf("query not scoped: %s", u)
		}
		return matrixOf(map[string]any{"metric": map[string]string{"signal": "hours"}, "values": []any{[]any{fixedT.Unix(), "2"}}}), nil
	}}
	j := &judge{}
	s := &Service{CVEHistoryEnabled: true, SAHistoryEnabled: true, PrometheusURL: "http://history", Backend: b, Judge: j, Now: func() time.Time { return fixedT }}
	r, err := s.SignalHistory(context.Background(), alice, SignalHistoryInput{Signal: "technical_debt", Namespaces: []string{"team|secret"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Series) != 1 || r.Series[0].Values[0][1] != 2 || r.StepSeconds != 3600 || len(j.asked) != 1 || j.asked[0].Namespace != "team|secret" {
		t.Fatalf("result %+v checks %+v", r, j.asked)
	}
	j.answer = func(_ authz.Identity, a authz.Attributes) authz.Verdict {
		if a.Namespace == "denied" || a.Namespace == "" {
			return authz.No
		}
		return authz.Yes
	}
	for _, namespaces := range [][]string{nil, {"team", "denied"}} {
		if _, err := s.SignalHistory(context.Background(), alice, SignalHistoryInput{Signal: "cves", Namespaces: namespaces}); err == nil {
			t.Fatal("unauthorized history allowed")
		}
	}
	if b.calls() != 1 {
		t.Fatal("backend called before scope authorization")
	}
	if _, err := s.SignalHistory(context.Background(), alice, SignalHistoryInput{Signal: "technical_debt", HoursPerUpgrade: -1}); err == nil {
		t.Fatal("negative effort accepted")
	}
}

// The same fixture can be checked by a remote promtool without adding a
// Prometheus server dependency to this application. Normal tests use a local
// promtool when installed; writing a fixture is explicit via this env variable.
func TestSignalHistoryPromQL(t *testing.T) {
	series := []any{}
	add := func(name, labels, value string) {
		series = append(series, map[string]any{"series": name + "{" + labels + "}", "values": value + "+0x2"})
	}
	for _, row := range []struct {
		uid, image, status string
		behind             string
	}{{"current", "i0", "known", "0"}, {"outdated", "i1", "known", "2"}, {"outdated", "i2", "known", "5"}, {"fallback", "i3", "unknown", ""}, {"missing", "i4", "unknown", ""}} {
		labels := `namespace="team",uid="` + row.uid + `",image="` + row.image + `"`
		add("driftmower_version_status", labels+`,status="`+row.status+`"`, "1")
		if row.behind != "" {
			add("driftmower_version_releases_behind", labels, row.behind)
		}
		if row.uid != "missing" {
			add("driftmower_image_created_timestamp_seconds", labels, "0")
		}
	}
	add("driftmower_version_status", `namespace="secret",uid="hidden",image="x",status="known"`, "1")
	add("driftmower_version_releases_behind", `namespace="secret",uid="hidden",image="x"`, "30")
	add("driftmower_security_inventory_timestamp_seconds", "", "1")
	add("driftmower_scanner_inventory_ready", "", "1")
	add("driftmower_running_image_containers", `namespace="team",digest="sha256:a"`, "2")
	add("driftmower_running_image_containers", `namespace="secret",digest="sha256:a"`, "4")
	for _, alias := range []string{"alias1", "alias2"} {
		add("driftmower_image_vulnerabilities", `image="`+alias+`",digest="sha256:a",severity="CRITICAL",fix_status="available"`, "3")
	}
	add("driftmower_image_scan_available", `digest="sha256:a"`, "1")
	for _, risk := range []string{"cluster_admin", "secrets_read"} {
		add("driftmower_serviceaccount_exposure", `namespace="team",serviceaccount="admin",risk="`+risk+`"`, "2")
	}
	for _, risk := range []string{"namespace_admin", "secrets_read"} {
		add("driftmower_serviceaccount_exposure", `namespace="team",serviceaccount="worker",risk="`+risk+`"`, "3")
	}
	tests := []any{}
	for _, tc := range []struct {
		signal string
		hours  float64
		want   map[string]float64
	}{
		{"technical_debt", 2, map[string]float64{"hours": 4, "version_backlog": 1, "build_age_fallback": 1, "unknown": 1}},
		{"technical_debt", 4, map[string]float64{"hours": 8, "version_backlog": 1, "build_age_fallback": 1, "unknown": 1}},
		{"cves", 1, map[string]float64{"critical": 3, "high": 0, "unscanned_images": 0}},
		{"serviceaccounts", 1, map[string]float64{"cluster_admin": 1, "broad_permissions": 1}},
	} {
		query, err := signalExpression(SignalHistoryInput{Signal: tc.signal, HoursPerUpgrade: tc.hours, BuildAgeDaysPerUpgrade: 1}, `namespace=~"team"`)
		if err != nil {
			t.Fatal(err)
		}
		expected := []any{}
		for _, name := range signalNames[tc.signal] {
			expected = append(expected, map[string]any{"labels": `{signal="` + name + `"}`, "value": tc.want[name]})
		}
		tests = append(tests, map[string]any{"interval": "1d", "input_series": series, "promql_expr_test": []any{map[string]any{"expr": query, "eval_time": "1d", "exp_samples": expected}}})
	}
	body, err := yaml.Marshal(map[string]any{"evaluation_interval": "1h", "tests": tests})
	if err != nil {
		t.Fatal(err)
	}
	if destination := os.Getenv("DRIFTMOWER_SIGNAL_TEST_FIXTURE"); destination != "" {
		if err := os.WriteFile(destination, body, 0600); err != nil {
			t.Fatal(err)
		}
	}
	tool, err := exec.LookPath("promtool")
	if err != nil {
		t.Skip("promtool is not installed; fixture generation and API tests still run")
	}
	path := filepath.Join(t.TempDir(), "signals.test.yaml")
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(tool, "test", "rules", path)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("promtool: %v\n%s", err, output)
	}
}
