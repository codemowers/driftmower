package kube

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"
	k8stesting "k8s.io/client-go/testing"
)

func TestCollectPagesUntilDone(t *testing.T) {
	var seen []metav1.ListOptions
	pages := [][]int{{1, 2}, {3}}
	got, err := Collect(context.Background(), func(_ context.Context, opts metav1.ListOptions) ([]int, string, error) {
		seen = append(seen, opts)
		i := len(seen) - 1
		next := ""
		if i == 0 {
			next = "page-2"
		}

		return pages[i], next, nil
	}, ListOptions{Limit: 2})
	if err != nil || !slices.Equal(got, []int{1, 2, 3}) {
		t.Fatalf("Collect = %v %v", got, err)
	}
	if seen[0].Limit != 2 || seen[0].Continue != "" || seen[1].Continue != "page-2" {
		t.Errorf("list options = %+v", seen)
	}
}

func TestCollectRefusesPartialResults(t *testing.T) {
	_, err := Collect(context.Background(), func(context.Context, metav1.ListOptions) ([]int, string, error) {
		return []int{1}, "more", nil
	}, ListOptions{MaxPages: 3, What: "Policy listing"})
	if err == nil || err.Error() != "Policy listing exceeds 3 pages; refusing to return an incomplete list" {
		t.Errorf("err = %v", err)
	}

	boom := errors.New("boom")
	if _, err := Collect(context.Background(), func(context.Context, metav1.ListOptions) ([]int, string, error) {
		return nil, "", boom
	}, ListOptions{}); !errors.Is(err, boom) {
		t.Errorf("err = %v", err)
	}
}

func TestNamespaceListerPagesAndCaches(t *testing.T) {
	client := fake.NewClientset(
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "b"}},
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "a"}},
	)
	lists := 0
	client.PrependReactor("list", "namespaces", func(k8stesting.Action) (bool, runtime.Object, error) {
		lists++

		return false, nil, nil
	})
	l := NewNamespaceLister(client)

	for range 2 {
		names, err := l.List(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		slices.Sort(names)
		if !slices.Equal(names, []string{"a", "b"}) {
			t.Fatalf("names = %v", names)
		}
	}
	if lists != 1 {
		t.Errorf("lists = %d, want cached", lists)
	}
	l.Invalidate()
	if _, err := l.List(context.Background()); err != nil || lists != 2 {
		t.Errorf("after Invalidate lists = %d, err = %v", lists, err)
	}
}

const aggregatedType = "application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList"

const aggregatedCore = `{"kind":"APIGroupDiscoveryList","apiVersion":"apidiscovery.k8s.io/v2","items":[
 {"metadata":{"name":""},"versions":[{"version":"v1","resources":[
  {"resource":"pods","responseKind":{"kind":"Pod"},"scope":"Namespaced","subresources":[{"subresource":"log","responseKind":{"kind":"Pod"}}]},
  {"resource":"nodes","responseKind":{"kind":"Node"},"scope":"Cluster"}]}]}]}`

func discoveryFor(t *testing.T, routes map[string]func(w http.ResponseWriter)) discovery.DiscoveryInterface {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if route, ok := routes[r.URL.Path]; ok {
			route(w)

			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)

	d, err := discovery.NewDiscoveryClientForConfig(&rest.Config{Host: srv.URL})
	if err != nil {
		t.Fatal(err)
	}

	return d
}

func serve(contentType, body string) func(http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", contentType)
		_, _ = w.Write([]byte(body))
	}
}

func TestLoadAPISurfaceAggregated(t *testing.T) {
	// Captured from a real apiserver and trimmed to the fields the parser reads.
	named, err := os.ReadFile("../../test/fixtures/kubernetes/aggregated-discovery.json")
	if err != nil {
		t.Fatal(err)
	}
	d := discoveryFor(t, map[string]func(http.ResponseWriter){
		"/api":  serve(aggregatedType, aggregatedCore),
		"/apis": serve(aggregatedType, string(named)),
	})

	surface, err := LoadAPISurface(d)
	if err != nil {
		t.Fatal(err)
	}

	want := map[string]ServedResource{
		"apps/v1/Deployment":                  {"apps", "v1", "Deployment", "deployments", true},
		"monitoring.coreos.com/v1/PodMonitor": {"monitoring.coreos.com", "v1", "PodMonitor", "podmonitors", true},
		"v1/Pod":                              {"", "v1", "Pod", "pods", true},
		"v1/Node":                             {"", "v1", "Node", "nodes", false},
	}
	for key, w := range want {
		if got := surface.ByKind[key]; got != w {
			t.Errorf("ByKind[%s] = %+v, want %+v", key, got, w)
		}
	}
	for key := range surface.ByKind {
		if strings.Contains(key, "/status") || strings.Contains(key, "/log") {
			t.Errorf("subresource %s in surface", key)
		}
	}
	if !surface.ServesGroup("monitoring.coreos.com") || surface.ServesGroup("postgresql.cnpg.io") {
		t.Error("ServesGroup wrong")
	}
	if !surface.ServesGroup("") {
		t.Error("core group missing")
	}
}

func TestLoadAPISurfaceLegacy(t *testing.T) {
	d := discoveryFor(t, map[string]func(http.ResponseWriter){
		"/api":    serve("application/json", `{"kind":"APIVersions","versions":["v1"]}`),
		"/api/v1": serve("application/json", `{"kind":"APIResourceList","groupVersion":"v1","resources":[{"name":"pods","kind":"Pod","namespaced":true,"verbs":["list"]}]}`),
		"/apis": serve("application/json", `{"kind":"APIGroupList","groups":[
			{"name":"monitoring.coreos.com","versions":[{"groupVersion":"monitoring.coreos.com/v1","version":"v1"}],"preferredVersion":{"groupVersion":"monitoring.coreos.com/v1","version":"v1"}},
			{"name":"apps.emqx.io","versions":[{"groupVersion":"apps.emqx.io/v2beta1","version":"v2beta1"},{"groupVersion":"apps.emqx.io/v2alpha1","version":"v2alpha1"}],"preferredVersion":{"groupVersion":"apps.emqx.io/v2beta1","version":"v2beta1"}},
			{"name":"gone.example.com","versions":[{"groupVersion":"gone.example.com/v1","version":"v1"}],"preferredVersion":{"groupVersion":"gone.example.com/v1","version":"v1"}}]}`),
		"/apis/monitoring.coreos.com/v1": serve("application/json", `{"kind":"APIResourceList","groupVersion":"monitoring.coreos.com/v1","resources":[
			{"name":"podmonitors","kind":"PodMonitor","namespaced":true,"verbs":["list"]},
			{"name":"podmonitors/status","kind":"PodMonitor","namespaced":true,"verbs":["get"]}]}`),
		"/apis/apps.emqx.io/v2beta1":  serve("application/json", `{"kind":"APIResourceList","groupVersion":"apps.emqx.io/v2beta1","resources":[{"name":"emqxes","kind":"EMQX","namespaced":true,"verbs":["list"]}]}`),
		"/apis/apps.emqx.io/v2alpha1": serve("application/json", `{"kind":"APIResourceList","groupVersion":"apps.emqx.io/v2alpha1","resources":[{"name":"emqxes","kind":"EMQX","namespaced":true,"verbs":["list"]}]}`),
		"/apis/gone.example.com/v1": func(w http.ResponseWriter) {
			w.WriteHeader(http.StatusServiceUnavailable)
		},
	})

	surface, err := LoadAPISurface(d)
	if err != nil {
		t.Fatal(err)
	}
	if got := surface.ByKind["monitoring.coreos.com/v1/PodMonitor"].Plural; got != "podmonitors" {
		t.Errorf("PodMonitor plural = %q", got)
	}
	if got := surface.ByKind["v1/Pod"].Plural; got != "pods" {
		t.Errorf("Pod plural = %q", got)
	}
	// The group exists, it just could not be listed.
	if !slices.Equal(surface.VersionsByGroup["gone.example.com"], []string{"v1"}) {
		t.Errorf("gone.example.com versions = %v", surface.VersionsByGroup["gone.example.com"])
	}
	if !slices.Equal(surface.VersionsByGroup["apps.emqx.io"], []string{"v2beta1", "v2alpha1"}) {
		t.Errorf("emqx versions = %v", surface.VersionsByGroup["apps.emqx.io"])
	}

	// Negotiation prefers the caller's order over the cluster's.
	if r, ok := surface.NegotiateVersion("apps.emqx.io", "EMQX", []string{"v2alpha1", "v2beta1"}); !ok || r.Version != "v2alpha1" {
		t.Errorf("NegotiateVersion = %+v %v", r, ok)
	}
	if _, ok := surface.NegotiateVersion("apps.emqx.io", "EMQX", []string{"v2alpha2"}); ok {
		t.Error("negotiated a version the cluster does not serve")
	}
}
