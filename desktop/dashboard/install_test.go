package dashboard

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

func TestInstallCommandFollowsClusterAuthCapability(t *testing.T) {
	anonymous := installCommand("admin@dev cluster", "anonymous")
	for _, want := range []string{
		"helm upgrade --install driftmower oci://ghcr.io/codemowers/charts/driftmower",
		"--kube-context 'admin@dev cluster'",
		"--namespace driftmower --create-namespace",
		"--set mcp.auth.mode=anonymous", "--set mcp.ingress.enabled=false", "--set mcp.portForwardOnly=true",
		"--set ui.enabled=false", "--set operator.enabled=false", "--set crawler.enabled=false", "--set registryScraper.enabled=false",
		"'mcp.dashboard.localOrigins={http://localhost:17843}'",
	} {
		if !strings.Contains(anonymous, want) {
			t.Fatalf("anonymous command lacks %q: %s", want, anonymous)
		}
	}
	rbac := installCommand("admin@prod", "rbac")
	if strings.Contains(rbac, "anonymous") || strings.Contains(rbac, "portForwardOnly") || !strings.Contains(rbac, "localOrigins") {
		t.Fatalf("Passmower clusters keep chart defaults: %s", rbac)
	}
	if got := shellQuote("it's"); got != `'it'\''s'` {
		t.Fatal(got)
	}
}

func TestInstallOfferDetectsPassmower(t *testing.T) {
	d := &ContextDiscovery{}
	client := fake.NewSimpleClientset()
	if offer := d.installOffer(context.Background(), client, "ctx", false); offer.AuthMode != "anonymous" || offer.Helm {
		t.Fatalf("cluster without Passmower: %+v", offer)
	}
	client.Resources = []*metav1.APIResourceList{{GroupVersion: passmowerGroup, APIResources: []metav1.APIResource{{Name: "oidcclients", Kind: "OIDCClient"}}}}
	if offer := d.installOffer(context.Background(), client, "ctx", true); offer.AuthMode != "rbac" || !offer.SSHJump || strings.Contains(offer.Command, "anonymous") {
		t.Fatalf("cluster with Passmower: %+v", offer)
	}
}

// installFixture writes a kubeconfig whose only credential is a static token
// and returns a desktop discovery that has seen the cluster without MCP.
func installFixture(t *testing.T, authMode string) (*ContextDiscovery, string) {
	t.Helper()
	raw := clientcmdapi.NewConfig()
	raw.Clusters["c"] = &clientcmdapi.Cluster{Server: "https://api.example:6443", CertificateAuthorityData: []byte("ca"), Extensions: map[string]runtime.Object{desktopExtension: &runtime.Unknown{Raw: []byte(`{"note":"desktop only"}`)}}}
	raw.AuthInfos["u"] = &clientcmdapi.AuthInfo{Token: "secret-token"}
	raw.Contexts["admin@example"] = &clientcmdapi.Context{Cluster: "c", AuthInfo: "u", Namespace: "team"}
	path := filepath.Join(t.TempDir(), "config")
	if err := clientcmd.WriteToFile(*raw, path); err != nil {
		t.Fatal(err)
	}
	d := StartDiscovery(false, path, true)
	t.Cleanup(d.Close)
	d.contexts = []DiscoveredContext{{Key: "identity", Name: "admin@example", Status: "not installed", Install: &InstallOffer{AuthMode: authMode, Helm: true}}}
	return d, path
}

func fakeHelm(t *testing.T, exit int) string {
	t.Helper()
	dir := t.TempDir()
	record := filepath.Join(dir, "record")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + record + "\ncat \"$KUBECONFIG\" > " + record + ".kubeconfig\necho \"$KUBECONFIG\" > " + record + ".path\n"
	if exit != 0 {
		script += "echo 'Error: INSTALLATION FAILED: namespaces is forbidden' >&2\nexit 1\n"
	}
	if err := os.WriteFile(filepath.Join(dir, "helm"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	return record
}

func TestInstallRunsHelmWithResolvedSingleContextKubeconfig(t *testing.T) {
	d, path := installFixture(t, "anonymous")
	record := fakeHelm(t, 0)
	if err := d.Install(context.Background(), "identity"); err != nil {
		t.Fatal(err)
	}
	args, _ := os.ReadFile(record)
	for _, want := range []string{"upgrade\n--install\ndriftmower\n", "--kube-context\nadmin@example\n", "--set\nmcp.portForwardOnly=true\n", "--wait\n--timeout\n5m\n"} {
		if !strings.Contains(string(args), want) {
			t.Fatalf("helm arguments lack %q:\n%s", want, args)
		}
	}
	if strings.Contains(string(args), path) {
		t.Fatal("helm received the person's kubeconfig instead of the resolved copy")
	}
	kubeconfig, _ := os.ReadFile(record + ".kubeconfig")
	written, err := clientcmd.Load(kubeconfig)
	if err != nil {
		t.Fatal(err)
	}
	if len(written.Contexts) != 1 || written.CurrentContext != "admin@example" || written.AuthInfos["user"].Token != "secret-token" || written.AuthInfos["user"].Exec != nil || len(written.Clusters["cluster"].Extensions) != 0 {
		t.Fatalf("install kubeconfig: %s", kubeconfig)
	}
	used, _ := os.ReadFile(record + ".path")
	if _, err := os.Stat(strings.TrimSpace(string(used))); !os.IsNotExist(err) {
		t.Fatal("temporary kubeconfig with credentials was left behind")
	}
	if contexts, _ := d.Snapshot(); contexts[0].Status != "checking" {
		t.Fatal("successful install did not refresh discovery")
	}
}

func TestInstallReportsHelmFailureAndRefusesUnknownAuth(t *testing.T) {
	d, _ := installFixture(t, "anonymous")
	fakeHelm(t, 1)
	err := d.Install(context.Background(), "identity")
	if err == nil || !strings.Contains(err.Error(), "namespaces is forbidden") {
		t.Fatalf("helm failure: %v", err)
	}
	unknown, _ := installFixture(t, "")
	if err := unknown.Install(context.Background(), "identity"); err == nil {
		t.Fatal("installed without knowing which auth mode fits the cluster")
	}
	if err := d.Install(context.Background(), "missing"); err == nil {
		t.Fatal("unknown connection accepted")
	}
}

func TestInstallRouteRequiresSameOrigin(t *testing.T) {
	d := New(&Config{KubeLogin: true})
	defer d.Close()
	d.discovery.contexts = []DiscoveredContext{{Key: "identity", Name: "missing-context", Install: &InstallOffer{AuthMode: "anonymous"}}}
	record := fakeHelm(t, 0)
	r := httptest.NewRequest(http.MethodPost, DesktopOrigin+"/api/desktop/install", strings.NewReader(`{"key":"identity"}`))
	r.Header.Set("Origin", "https://evil.example")
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	d.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatal(w.Code)
	}
	time.Sleep(10 * time.Millisecond)
	if _, err := os.Stat(record); !os.IsNotExist(err) {
		t.Fatal("cross-origin request ran helm")
	}
}
