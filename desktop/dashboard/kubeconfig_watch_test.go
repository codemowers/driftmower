package dashboard

import (
	"bufio"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

func writeWatchConfig(t *testing.T, path, name, server string) {
	t.Helper()
	config := clientcmdapi.NewConfig()
	config.Clusters[name] = &clientcmdapi.Cluster{Server: server}
	config.AuthInfos[name] = &clientcmdapi.AuthInfo{Token: "test-token"}
	config.Contexts[name] = &clientcmdapi.Context{Cluster: name, AuthInfo: name}
	config.CurrentContext = name
	if err := clientcmd.WriteToFile(*config, path); err != nil {
		t.Fatal(err)
	}
}
func waitConfigNames(t *testing.T, d *ContextDiscovery, changes <-chan struct{}, want ...string) {
	t.Helper()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for {
		contexts, _ := d.Snapshot()
		var names []string
		for _, c := range contexts {
			names = append(names, c.Name)
		}
		slices.Sort(names)
		if slices.Equal(names, want) {
			return
		}
		select {
		case <-changes:
		case <-deadline.C:
			t.Fatalf("contexts %v, want %v", names, want)
		}
	}
}
func TestKubeconfigWatcherHandlesAtomicReplaceAndRemoval(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config")
	writeWatchConfig(t, path, "first", "https://127.0.0.1:1")
	discovery := StartDiscovery(true, path, false)
	defer discovery.Close()
	changes, stop := discovery.subscribe()
	defer stop()
	waitConfigNames(t, discovery, changes, "first")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	replacement := path + ".new"
	writeWatchConfig(t, replacement, "other", "https://127.0.0.1:1")
	if err := os.Chtimes(replacement, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, path); err != nil {
		t.Fatal(err)
	}
	waitConfigNames(t, discovery, changes, "other")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	waitConfigNames(t, discovery, changes, "kubeconfig")
	writeWatchConfig(t, path, "again", "https://127.0.0.1:1")
	waitConfigNames(t, discovery, changes, "again")
}
func TestKubeconfigWatcherTracksEveryMergedFileIncludingNewDirectories(t *testing.T) {
	root := t.TempDir()
	first := filepath.Join(root, "first")
	second := filepath.Join(root, "new", "second")
	writeWatchConfig(t, first, "alpha", "https://127.0.0.1:1")
	t.Setenv("KUBECONFIG", first+string(os.PathListSeparator)+second)
	discovery := StartDiscovery(true, "", false)
	defer discovery.Close()
	changes, stop := discovery.subscribe()
	defer stop()
	waitConfigNames(t, discovery, changes, "alpha")
	writeWatchConfig(t, second, "bravo", "https://127.0.0.1:2")
	waitConfigNames(t, discovery, changes, "alpha", "bravo")
	if err := os.Remove(first); err != nil {
		t.Fatal(err)
	}
	waitConfigNames(t, discovery, changes, "bravo")
}
func TestDesktopConfigEventsPushChangesAndRejectOtherOrigins(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config")
	writeWatchConfig(t, path, "before", "https://127.0.0.1:1")
	app := New(&Config{DiscoverKubeconfig: true, KubeLogin: true, Kubeconfig: path})
	defer app.Close()
	server := httptest.NewServer(app.Handler())
	defer server.Close()
	client := &http.Client{Timeout: 5 * time.Second}
	request, err := http.NewRequest("GET", server.URL+"/api/desktop/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", "https://other.example")
	denied, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if err := denied.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if denied.StatusCode != 403 {
		t.Fatalf("cross-origin events: %d", denied.StatusCode)
	}
	response, err := client.Get(server.URL + "/api/desktop/events")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != 200 || response.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("events: %d", response.StatusCode)
	}
	scanner := bufio.NewScanner(response.Body)
	if !scanner.Scan() || scanner.Text() != "data: changed" {
		t.Fatal("missing initial event")
	}
	if !app.GetConfig().ConfigUpdates || app.LastSeen().IsZero() {
		t.Fatal("active desktop config stream not registered")
	}
	writeWatchConfig(t, path, "after", "https://127.0.0.1:1")
	for scanner.Scan() {
		config := app.GetConfig()
		if slices.ContainsFunc(config.Contexts, func(c DiscoveredContext) bool { return c.Name == "after" }) {
			return
		}
	}
	t.Fatalf("no pushed update: %v", scanner.Err())
}
