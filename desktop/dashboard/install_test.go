package dashboard

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	storagev1 "k8s.io/api/storage/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

func TestInstallCommandFollowsClusterAuthCapability(t *testing.T) {
	anonymous := installCommand("admin@dev cluster", installSettings{authMode: "anonymous"})
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
	rbac := installCommand("admin@prod", installSettings{authMode: "rbac", hostExpansion: true})
	if strings.Contains(rbac, "anonymous") || strings.Contains(rbac, "portForwardOnly") || strings.Contains(rbac, "ingress") || !strings.Contains(rbac, "localOrigins") {
		t.Fatalf("Passmower clusters with host expansion keep chart defaults: %s", rbac)
	}
	unexpanded := installCommand("admin@cluster", installSettings{authMode: "rbac"})
	if strings.Contains(unexpanded, "anonymous") || !strings.Contains(unexpanded, "--set mcp.ingress.enabled=false") || !strings.Contains(unexpanded, "--set ui.enabled=false") {
		t.Fatalf("unexpanded short hosts must not be advertised: %s", unexpanded)
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
	offer := d.installOffer(context.Background(), client, "ctx", true)
	if offer.AuthMode != "rbac" || !offer.SSHJump || strings.Contains(offer.Command, "anonymous") || offer.HostExpansion || !strings.Contains(offer.Command, "mcp.ingress.enabled=false") {
		t.Fatalf("cluster with Passmower, no host expansion: %+v", offer)
	}
	client.PrependReactor("create", "ingresses", func(action k8stesting.Action) (bool, runtime.Object, error) {
		create := action.(k8stesting.CreateActionImpl)
		ingress := create.GetObject().(*networkingv1.Ingress).DeepCopy()
		if len(create.CreateOptions.DryRun) == 0 {
			t.Fatal("host expansion check persisted an Ingress")
		}
		ingress.Spec.Rules[0].Host += ".example.com"
		return true, ingress, nil
	})
	if offer := d.installOffer(context.Background(), client, "ctx", false); !offer.HostExpansion || strings.Contains(offer.Command, "ingress.enabled") {
		t.Fatalf("cluster expanding short hosts: %+v", offer)
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
	script := "#!/bin/sh\nif [ \"$1\" = show ]; then\n  [ \"$2\" = chart ] && echo 'version: 0.0.0-test' || cat \"${FAKE_CHART_VALUES:-" + chartValuesPath(t) + "}\"\n  exit 0\nfi\necho \"$3\" >> " + record + ".calls\nprintf '%s\\n' \"$@\" > " + record + "\ncat \"$KUBECONFIG\" > " + record + ".kubeconfig\necho \"$KUBECONFIG\" > " + record + ".path\n"
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
	if err := d.Install(context.Background(), "identity", InstallOptions{}); err != nil {
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
	err := d.Install(context.Background(), "identity", InstallOptions{})
	if err == nil || !strings.Contains(err.Error(), "namespaces is forbidden") {
		t.Fatalf("helm failure: %v", err)
	}
	unknown, _ := installFixture(t, "")
	if err := unknown.Install(context.Background(), "identity", InstallOptions{}); err == nil {
		t.Fatal("installed without knowing which auth mode fits the cluster")
	}
	if err := d.Install(context.Background(), "missing", InstallOptions{}); err == nil {
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

func TestInstallOfferPlansClusterCATrustForOIDC(t *testing.T) {
	d := &ContextDiscovery{kubeLogin: true}
	t.Setenv("PATH", filepath.Dir(fakeHelm(t, 0)))
	passmower := func(extra ...*metav1.APIResourceList) *fake.Clientset {
		client := fake.NewSimpleClientset()
		client.Resources = append([]*metav1.APIResourceList{{GroupVersion: passmowerGroup, APIResources: []metav1.APIResource{{Name: "oidcclients"}}}}, extra...)
		return client
	}
	// No admission injects a CA bundle: plan the platform's trust layer.
	missing := d.installOffer(context.Background(), passmower(), "admin@cluster", false)
	if missing.TrustedCA != "missing" || missing.Trust == nil || missing.Trust.CertManager || missing.Trust.TrustManager || !missing.Helm {
		t.Fatalf("OIDC install without cluster CAs: %+v", missing)
	}
	if !strings.Contains(missing.Command, "--set trustedCA.configMapName=trusted-ca-certs") || len(missing.Trust.Commands) != 3 ||
		!strings.Contains(missing.Trust.Commands[0], "charts/cert-manager --version 1.20.0") || !strings.Contains(missing.Trust.Commands[1], "charts/trust-manager --version 0.22.0") ||
		!strings.Contains(missing.Trust.Commands[2], "name: trusted-ca-certs") || !strings.Contains(missing.Trust.Commands[2], "--context admin@cluster") {
		t.Fatalf("trust plan: %s %q", missing.Command, missing.Trust.Commands)
	}
	withCertManager := d.installOffer(context.Background(), passmower(&metav1.APIResourceList{GroupVersion: "cert-manager.io/v1", APIResources: []metav1.APIResource{{Name: "certificates"}}}), "ctx", false)
	if withCertManager.Trust == nil || !withCertManager.Trust.CertManager || len(withCertManager.Trust.Commands) != 2 {
		t.Fatalf("existing cert-manager: %+v", withCertManager.Trust)
	}
	// Anonymous MCP makes no outbound TLS calls and needs no trust layer.
	if offer := d.installOffer(context.Background(), fake.NewSimpleClientset(), "ctx", false); offer.Trust != nil || !offer.Helm {
		t.Fatalf("anonymous install: %+v", offer)
	}
	injected := passmower()
	injected.PrependReactor("create", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
		create := action.(k8stesting.CreateActionImpl)
		if len(create.CreateOptions.DryRun) == 0 {
			t.Fatal("CA injection check persisted a Pod")
		}
		pod := create.GetObject().(*corev1.Pod).DeepCopy()
		pod.Spec.Containers[0].Env = append(pod.Spec.Containers[0].Env, corev1.EnvVar{Name: "SSL_CERT_FILE", Value: "/etc/ssl/certs/ca.pem"})
		return true, pod, nil
	})
	if offer := d.installOffer(context.Background(), injected, "ctx", false); offer.TrustedCA != "injected" || offer.Trust != nil || strings.Contains(offer.Command, "trustedCA") {
		t.Fatalf("platform with trusted-CA policy: %+v", offer)
	}
	refused := passmower()
	refused.PrependReactor("create", "pods", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(corev1.Resource("pods"), "", nil)
	})
	if offer := d.installOffer(context.Background(), refused, "ctx", false); offer.TrustedCA != "" || offer.Trust != nil {
		t.Fatalf("an undeterminable check must not plan cluster changes: %+v", offer)
	}
}

func TestInstallSetsUpTrustLayerInOrder(t *testing.T) {
	d, _ := installFixture(t, "rbac")
	d.contexts[0].Install.Trust = &TrustSetup{Bundle: true}
	d.contexts[0].Install.DefaultStorageClass = "longhorn"
	record := fakeHelm(t, 0)
	if err := d.Install(context.Background(), "identity", InstallOptions{}); err == nil || !strings.Contains(err.Error(), "cert-manager") {
		t.Fatalf("installed without consenting to cert-manager: %v", err)
	}
	if _, err := os.Stat(record + ".calls"); !os.IsNotExist(err) {
		t.Fatal("helm ran without consent")
	}
	if err := d.Install(context.Background(), "identity", InstallOptions{InstallCertManager: true}); err != nil {
		t.Fatal(err)
	}
	calls, _ := os.ReadFile(record + ".calls")
	if string(calls) != "cert-manager\ntrust-manager\ndriftmower\n" {
		t.Fatalf("install order: %q", calls)
	}
	args, _ := os.ReadFile(record)
	if !strings.Contains(string(args), "--set\ntrustedCA.configMapName=trusted-ca-certs\n") {
		t.Fatalf("Driftmower does not mount the bundle:\n%s", args)
	}
	// With cert-manager present only trust-manager and Driftmower run.
	_ = os.Remove(record + ".calls")
	d.contexts[0].Install.Trust = &TrustSetup{CertManager: true, Bundle: true}
	if err := d.Install(context.Background(), "identity", InstallOptions{}); err != nil {
		t.Fatal(err)
	}
	if calls, _ := os.ReadFile(record + ".calls"); string(calls) != "trust-manager\ndriftmower\n" {
		t.Fatalf("existing cert-manager reinstalled: %q", calls)
	}
}

func TestCreateTrustBundleMatchesPlatformAndKeepsExisting(t *testing.T) {
	var created map[string]any
	exists := false
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/apis/trust.cert-manager.io/v1alpha1/bundles" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		if exists {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"AlreadyExists","code":409}`))
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&created)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(created)
	}))
	defer server.Close()
	config := clientcmdapi.NewConfig()
	config.Clusters["c"] = &clientcmdapi.Cluster{Server: server.URL, InsecureSkipTLSVerify: true}
	config.AuthInfos["u"] = &clientcmdapi.AuthInfo{Token: "t"}
	config.Contexts["x"] = &clientcmdapi.Context{Cluster: "c", AuthInfo: "u"}
	config.CurrentContext = "x"
	path := filepath.Join(t.TempDir(), "kubeconfig")
	if err := clientcmd.WriteToFile(*config, path); err != nil {
		t.Fatal(err)
	}
	if err := createTrustBundle(context.Background(), path); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(created)
	for _, want := range []string{`"name":"trusted-ca-certs"`, `"useDefaultCAs":true`, `"key":"ca.pem"`, `"namespaceSelector":{}`} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("Bundle lacks %s: %s", want, body)
		}
	}
	exists = true
	if err := createTrustBundle(context.Background(), path); err != nil {
		t.Fatalf("an existing Bundle must be kept: %v", err)
	}
}

// chartValuesPath is the repository chart's values.yaml, which the fake helm
// serves for `helm show values`.
func chartValuesPath(t *testing.T) string {
	t.Helper()
	path, err := filepath.Abs(filepath.Join("..", "..", "chart", "values.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	return path
}

func TestInstallPinsCheckedChartAndRefusesOlderCharts(t *testing.T) {
	d, _ := installFixture(t, "anonymous")
	record := fakeHelm(t, 0)
	if err := d.Install(context.Background(), "identity", InstallOptions{}); err != nil {
		t.Fatal(err)
	}
	args, _ := os.ReadFile(record)
	if !strings.Contains(string(args), "--version\n0.0.0-test\n") {
		t.Fatalf("install did not pin the checked chart:\n%s", args)
	}
	// A published chart without a value this desktop sets must not install.
	old := filepath.Join(t.TempDir(), "values.yaml")
	body, _ := os.ReadFile(chartValuesPath(t))
	if err := os.WriteFile(old, []byte(strings.Replace(string(body), "portForwardOnly:", "removedForTest:", 1)), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_CHART_VALUES", old)
	_ = os.Remove(record)
	err := d.Install(context.Background(), "identity", InstallOptions{})
	if err == nil || !strings.Contains(err.Error(), "0.0.0-test") || !strings.Contains(err.Error(), "mcp.portForwardOnly") {
		t.Fatalf("older chart: %v", err)
	}
	if _, err := os.Stat(record); !os.IsNotExist(err) {
		t.Fatal("helm installed a chart lacking required values")
	}
}

func TestInstallRequiresStorageClassWithoutClusterDefault(t *testing.T) {
	client := fake.NewSimpleClientset(
		&storagev1.StorageClass{ObjectMeta: metav1.ObjectMeta{Name: "zfs"}},
		&storagev1.StorageClass{ObjectMeta: metav1.ObjectMeta{Name: "hostpath"}},
	)
	client.Resources = []*metav1.APIResourceList{{GroupVersion: passmowerGroup, APIResources: []metav1.APIResource{{Name: "oidcclients"}}}}
	offer := (&ContextDiscovery{}).installOffer(context.Background(), client, "ctx", false)
	if strings.Join(offer.StorageClasses, ",") != "hostpath,zfs" || offer.DefaultStorageClass != "" || !strings.Contains(offer.Command, "operator.sbomStorageClassName=<storage-class>") {
		t.Fatalf("no default StorageClass: %+v", offer)
	}
	withDefault := fake.NewSimpleClientset(&storagev1.StorageClass{ObjectMeta: metav1.ObjectMeta{Name: "longhorn", Annotations: map[string]string{"storageclass.kubernetes.io/is-default-class": "true"}}})
	withDefault.Resources = client.Resources
	if offer := (&ContextDiscovery{}).installOffer(context.Background(), withDefault, "ctx", false); offer.DefaultStorageClass != "longhorn" || strings.Contains(offer.Command, "StorageClassName") {
		t.Fatalf("default StorageClass: %+v", offer)
	}

	d, _ := installFixture(t, "rbac")
	d.contexts[0].Install.StorageClasses = []string{"hostpath", "zfs"}
	record := fakeHelm(t, 0)
	for _, choice := range []string{"", "missing"} {
		if err := d.Install(context.Background(), "identity", InstallOptions{StorageClass: choice}); err == nil || !strings.Contains(err.Error(), "StorageClass") {
			t.Fatalf("storage %q: %v", choice, err)
		}
	}
	if err := d.Install(context.Background(), "identity", InstallOptions{StorageClass: "zfs"}); err != nil {
		t.Fatal(err)
	}
	args, _ := os.ReadFile(record)
	for _, want := range []string{"operator.sbomStorageClassName=zfs", "registryScraper.storageClassName=zfs"} {
		if !strings.Contains(string(args), want) {
			t.Fatalf("missing %s:\n%s", want, args)
		}
	}
}

func TestOlderChartStopsInstallBeforeTrustLayer(t *testing.T) {
	d, _ := installFixture(t, "rbac")
	d.contexts[0].Install.Trust = &TrustSetup{CertManager: true}
	d.contexts[0].Install.DefaultStorageClass = "longhorn"
	record := fakeHelm(t, 0)
	old := filepath.Join(t.TempDir(), "values.yaml")
	body, _ := os.ReadFile(chartValuesPath(t))
	if err := os.WriteFile(old, []byte(strings.Replace(string(body), "trustedCA:", "removedForTest:", 1)), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_CHART_VALUES", old)
	if err := d.Install(context.Background(), "identity", InstallOptions{}); err == nil || !strings.Contains(err.Error(), "trustedCA.configMapName") {
		t.Fatalf("older chart: %v", err)
	}
	if _, err := os.Stat(record + ".calls"); !os.IsNotExist(err) {
		t.Fatal("the trust layer was installed for a chart that cannot use it")
	}
}

func TestTrustSetupEncodesNoStepsAsEmptyList(t *testing.T) {
	client := fake.NewSimpleClientset()
	client.Resources = []*metav1.APIResourceList{
		{GroupVersion: "cert-manager.io/v1", APIResources: []metav1.APIResource{{Name: "certificates"}}},
		{GroupVersion: "trust.cert-manager.io/v1alpha1", APIResources: []metav1.APIResource{{Name: "bundles"}}},
	}
	setup := trustSetup(context.Background(), client, "ctx")
	setup.Bundle = true
	setup.Commands = setup.Commands[:0]
	body, _ := json.Marshal(setup)
	if !strings.Contains(string(body), `"commands":[]`) {
		t.Fatalf("Settings maps over commands; got %s", body)
	}
}

func TestLocalChartOverrideUsesPublishedImagesUnpinned(t *testing.T) {
	d, _ := installFixture(t, "anonymous")
	record := fakeHelm(t, 0)
	local := filepath.Dir(chartValuesPath(t))
	t.Setenv("DRIFTMOWER_INSTALL_CHART", local)
	if err := d.Install(context.Background(), "identity", InstallOptions{}); err != nil {
		t.Fatal(err)
	}
	args, _ := os.ReadFile(record)
	if !strings.Contains(string(args), "\n"+local+"\n") || strings.Contains(string(args), "--version") {
		t.Fatalf("local chart not used unpinned:\n%s", args)
	}
	for _, want := range []string{"--set\nmcp.image=driftmower-mcp\n", "--set\noperator.databaseImage="} {
		if !strings.Contains(string(args), want) {
			t.Fatalf("release image %q not set:\n%s", want, args)
		}
	}
	if offer := d.contexts[0].Install; strings.Contains(installCommand("ctx", installSettings{authMode: offer.AuthMode}), local) {
		t.Fatal("the copyable command must keep the published chart")
	}
}

func TestFullInstallAddsNodestatdWhenItsAPIsAreMissing(t *testing.T) {
	d := &ContextDiscovery{}
	passmower := []*metav1.APIResourceList{{GroupVersion: passmowerGroup, APIResources: []metav1.APIResource{{Name: "oidcclients"}}}}
	k3s := fake.NewSimpleClientset(&corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "n"}, Status: corev1.NodeStatus{NodeInfo: corev1.NodeSystemInfo{KubeletVersion: "v1.33.4+k3s1"}}})
	k3s.Resources = passmower
	offer := d.installOffer(context.Background(), k3s, "admin@cluster", false)
	if offer.Nodestatd == nil || !offer.Nodestatd.K3s || !strings.Contains(offer.Nodestatd.Command, "charts/nodestatd") ||
		!strings.Contains(offer.Nodestatd.Command, "--namespace kube-system") || !strings.Contains(offer.Nodestatd.Command, "containerd.socket=/run/k3s/containerd/containerd.sock") {
		t.Fatalf("k3s without nodestatd: %+v", offer.Nodestatd)
	}
	installed := fake.NewSimpleClientset()
	installed.Resources = append(passmower, &metav1.APIResourceList{GroupVersion: "codemowers.io/v1alpha1", APIResources: []metav1.APIResource{{Name: "containerimages"}, {Name: "sourcerepositories"}}})
	if offer := d.installOffer(context.Background(), installed, "ctx", false); offer.Nodestatd != nil {
		t.Fatalf("nodestatd already installed: %+v", offer.Nodestatd)
	}
	// The anonymous profile stays MCP-only.
	if offer := d.installOffer(context.Background(), fake.NewSimpleClientset(), "ctx", false); offer.Nodestatd != nil {
		t.Fatalf("anonymous install: %+v", offer.Nodestatd)
	}

	install, _ := installFixture(t, "rbac")
	install.contexts[0].Install.DefaultStorageClass = "longhorn"
	install.contexts[0].Install.Nodestatd = &NodestatdSetup{}
	record := fakeHelm(t, 0)
	if err := install.Install(context.Background(), "identity", InstallOptions{}); err != nil {
		t.Fatal(err)
	}
	if calls, _ := os.ReadFile(record + ".calls"); string(calls) != "nodestatd\ndriftmower\n" {
		t.Fatalf("nodestatd must install before Driftmower: %q", calls)
	}
}
