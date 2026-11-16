package observability

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codemowers/driftmower/mcp/internal/authz"
)

func alertmanagerFixture(t *testing.T, allow func(authz.Attributes) bool) (*Service, *[]map[string]any) {
	t.Helper()
	var created []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v2/alerts":
			_, _ = io.WriteString(w, `[
				{"labels":{"alertname":"KubePodCrashLooping","severity":"warning","namespace":"team-a"},"annotations":{"summary":"crash"},"startsAt":"2026-11-11T10:00:00Z","fingerprint":"a","status":{"state":"active"}},
				{"labels":{"alertname":"TargetDown","severity":"critical","namespace":"team-b"},"startsAt":"2026-11-11T10:00:00Z","fingerprint":"b","status":{"state":"active"}},
				{"labels":{"alertname":"Watchdog","severity":"none"},"startsAt":"2026-11-11T10:00:00Z","fingerprint":"c","status":{"state":"active"}}]`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/v2/silences":
			_, _ = io.WriteString(w, `[
				{"id":"s-a","matchers":[{"name":"namespace","value":"team-a","isEqual":true}],"status":{"state":"active"}},
				{"id":"s-b","matchers":[{"name":"namespace","value":"team-b","isEqual":true}],"status":{"state":"active"}}]`)
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/v2/silence/"):
			ns := strings.TrimPrefix(r.URL.Path, "/api/v2/silence/s-")
			_, _ = io.WriteString(w, `{"id":"s-`+ns+`","matchers":[{"name":"namespace","value":"team-`+ns+`","isEqual":true}],"status":{"state":"active"}}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/v2/silences":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			created = append(created, body)
			_, _ = io.WriteString(w, `{"silenceID":"new"}`)
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusOK)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	j := &judge{answer: func(_ authz.Identity, a authz.Attributes) authz.Verdict {
		if allow(a) {
			return authz.Yes
		}

		return authz.No
	}}

	return &Service{AlertmanagerURL: srv.URL, Backend: HTTPRequester(5 * time.Second), Judge: j, Now: func() time.Time { return usageT }}, &created
}

// team-a member: may list pods and create alertmanagerconfigs in team-a only.
func teamA(a authz.Attributes) bool { return a.Namespace == "team-a" }

func TestAlertsScopedToReadableNamespaces(t *testing.T) {
	svc, _ := alertmanagerFixture(t, teamA)
	res, err := svc.ListAlerts(context.Background(), alice, AlertsInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Alerts) != 1 || res.Alerts[0].Namespace != "team-a" || !res.Alerts[0].CanSilence || res.Hidden != 2 {
		t.Fatalf("alerts = %+v hidden %d", res.Alerts, res.Hidden)
	}
	if len(res.Silences) != 1 || res.Silences[0].ID != "s-a" {
		t.Fatalf("silences = %+v", res.Silences)
	}
	if _, err := svc.ListAlerts(context.Background(), alice, AlertsInput{Namespace: "team-b"}); err == nil {
		t.Fatal("team-b alerts readable without list pods there")
	}
}

func TestClusterAdminSeesAlertsWithoutNamespace(t *testing.T) {
	svc, _ := alertmanagerFixture(t, func(authz.Attributes) bool { return true })
	res, err := svc.ListAlerts(context.Background(), alice, AlertsInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Alerts) != 3 || res.Hidden != 0 || res.Alerts[0].Severity != "critical" || res.BySeverity["none"] != 1 {
		t.Fatalf("alerts = %+v", res.Alerts)
	}
}

func TestSilencesNeedNamespacePermission(t *testing.T) {
	svc, created := alertmanagerFixture(t, teamA)
	ctx := context.Background()
	if _, err := svc.CreateSilence(ctx, alice, SilenceInput{Namespace: "team-a", Matchers: map[string]string{"alertname": "KubePodCrashLooping"}, Comment: "deploying"}); err != nil {
		t.Fatal(err)
	}
	m := (*created)[0]["matchers"].([]any)
	if len(m) != 2 || m[0].(map[string]any)["name"] != "namespace" || m[0].(map[string]any)["value"] != "team-a" || (*created)[0]["createdBy"] != alice.User {
		t.Fatalf("silence = %v", (*created)[0])
	}
	for _, in := range []SilenceInput{
		{Namespace: "team-b", Comment: "x"},
		{Matchers: map[string]string{"alertname": "TargetDown"}, Comment: "x"},
		{Namespace: "team-a", Matchers: map[string]string{"namespace": "team-b"}, Comment: "x"},
		{Namespace: "team-a"},
	} {
		if _, err := svc.CreateSilence(ctx, alice, in); err == nil {
			t.Errorf("silence %+v accepted", in)
		}
	}
	if _, err := svc.ExpireSilence(ctx, alice, "s-a"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ExpireSilence(ctx, alice, "s-b"); err == nil {
		t.Fatal("team-b silence expired without permission there")
	}
}
