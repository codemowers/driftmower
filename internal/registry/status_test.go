package registry

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

func TestRegistryStateAndBackoffAreHostWide(t *testing.T) {
	tracker := &RegistryStatusTracker{}
	tracker.Configure([]RepositoryConfig{{Repository: "docker.io/library/python"}, {Repository: "docker.io/library/alpine"}, {Repository: "ghcr.io/astral-sh/uv"}})
	now := time.Now()
	if got := tracker.Snapshot(now); len(got) != 2 || got[0].State != "idle" {
		t.Fatal(got)
	}
	tracker.Start("docker.io/library/python")
	if got := tracker.Snapshot(now)[0]; got.State != "scraping" || len(got.ActiveRepositories) != 1 {
		t.Fatal(got)
	}
	tracker.Request("docker.io", &http.Response{StatusCode: 429, Header: http.Header{"Retry-After": []string{"120"}}}, nil, now, false)
	tracker.Request("docker.io", &http.Response{StatusCode: 200, Header: http.Header{}}, nil, now.Add(time.Second), false)
	if got := tracker.Snapshot(now)[0]; got.State != "throttled" || got.RetryAt != now.Add(2*time.Minute) {
		t.Fatal(got)
	}
	var limited *HTTPError
	if !errors.As(tracker.Blocked("docker.io", now), &limited) || limited.Status != 429 || tracker.Blocked("ghcr.io", now) != nil {
		t.Fatal("registry backoff leaked or was lost")
	}
	tracker.Finish("docker.io/library/python", []string{"registry HTTP 429"}, now)
	if got := tracker.Snapshot(now)[0]; got.State != "throttled" || len(got.ActiveRepositories) != 0 {
		t.Fatal(got)
	}
	reg := prometheus.NewRegistry()
	reg.MustRegister(tracker)
	metrics, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	oneHot := map[string]float64{}
	for _, family := range metrics {
		if family.GetName() == "driftmower_registry_state" {
			for _, m := range family.Metric {
				for _, l := range m.Label {
					if l.GetName() == "registry" {
						oneHot[l.GetValue()] += m.GetGauge().GetValue()
					}
				}
			}
		}
	}
	if oneHot["docker.io"] != 1 || oneHot["ghcr.io"] != 1 {
		t.Fatal(oneHot)
	}
	if got := tracker.Snapshot(now.Add(3 * time.Minute))[0]; got.State != "idle" {
		t.Fatal(got)
	}
}

func TestRateLimitWithoutRetryAfterStopsOtherRepositories(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(429) }))
	defer server.Close()
	tracker := &RegistryStatusTracker{}
	client := &Client{HTTP: server.Client(), Endpoint: func(string) string { return server.URL }, Status: tracker}
	_, err := client.Tags(context.Background(), "docker.io/library/python")
	var limited *HTTPError
	if !errors.As(err, &limited) || limited.RetryAfter != 15*time.Minute {
		t.Fatalf("missing default backoff: %v", err)
	}
	_, _ = client.Tags(context.Background(), "docker.io/library/alpine")
	if calls != 1 {
		t.Fatalf("throttled registry received %d requests", calls)
	}
	_, _ = client.Tags(context.Background(), "ghcr.io/astral-sh/uv")
	if calls != 2 {
		t.Fatal("another registry was unnecessarily blocked")
	}
}
