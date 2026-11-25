package dashboard

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

func chromeFixture(t *testing.T) *BrowserProfiles {
	t.Helper()
	root := t.TempDir()
	for _, dir := range []string{"Default", "Profile 1"} {
		if err := os.Mkdir(filepath.Join(root, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	state := `{"profile":{"info_cache":{"Default":{"name":"Personal","user_name":"private@example.com"},"Profile 1":{"name":"Work"},"../escape":{"name":"Invalid"}}},"unrelated":"not exposed"}`
	if err := os.WriteFile(filepath.Join(root, "Local State"), []byte(state), 0600); err != nil {
		t.Fatal(err)
	}
	p, err := NewBrowserProfiles(BrowserChrome, "/fake/chrome", root)
	if err != nil {
		t.Fatal(err)
	}
	p.cache = filepath.Join(t.TempDir(), "cache")
	return p
}

func TestBrowserProfilesKubeconfigExtensionPreservesAuthAndAliases(t *testing.T) {
	p := chromeFixture(t)
	profiles, err := p.List()
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(profiles)
	if len(profiles) != 2 || strings.Contains(string(body), "private") || strings.Contains(string(body), "escape") {
		t.Fatalf("profile discovery leaked extra fields: %s", body)
	}
	raw := clientcmdapi.NewConfig()
	raw.Clusters["one"] = &clientcmdapi.Cluster{Server: "https://api.one"}
	raw.Clusters["two"] = &clientcmdapi.Cluster{Server: "https://api.two"}
	auth := oidcUser()
	auth.ClientCertificate = "relative-client.crt"
	auth.Extensions = map[string]runtime.Object{
		"other.example/tool": &runtime.Unknown{Raw: []byte(`{"keep":"me"}`)},
		desktopExtension:     &runtime.Unknown{Raw: []byte(`{"future":true,"chromeProfiles":{"https://api.two":{"name":"Personal","directory":"Default","future":42}}}`)},
	}
	raw.AuthInfos["user"] = auth
	raw.AuthInfos["alias-user"] = auth.DeepCopy()
	raw.AuthInfos["different-user"] = &clientcmdapi.AuthInfo{Token: "different-identity"}
	raw.Contexts["one"] = &clientcmdapi.Context{Cluster: "one", AuthInfo: "user"}
	raw.Contexts["one/team"] = &clientcmdapi.Context{Cluster: "one", AuthInfo: "alias-user", Namespace: "team"}
	raw.Contexts["two"] = &clientcmdapi.Context{Cluster: "two", AuthInfo: "user"}
	raw.Contexts["different"] = &clientcmdapi.Context{Cluster: "one", AuthInfo: "different-user"}
	raw.CurrentContext = "two"
	path := filepath.Join(t.TempDir(), "config")
	if err := clientcmd.WriteToFile(*raw, path); err != nil {
		t.Fatal(err)
	}
	d := StartDiscovery(false, path, true, p)
	defer d.Close()
	resolved, err := d.load()
	if err != nil {
		t.Fatal(err)
	}
	var key string
	for _, g := range contextGroups(resolved, BrowserChrome) {
		if g.Name == "one" {
			key = g.Key
		}
	}
	if key == "" {
		t.Fatal("missing context group")
	}
	oldForward := &desktopForward{stop: make(chan struct{}), done: make(chan struct{})}
	oldProfile := &BrowserProfile{Directory: "Default", Name: "Personal"}
	d.forwards.entries[forwardIdentityKey(key, oldProfile)] = &forwardEntry{forward: oldForward}
	go func() { <-oldForward.stop; close(oldForward.done) }()
	if err := p.Set(d, key, "Profile 1"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-oldForward.done:
	default:
		t.Fatal("changing profile retained the previous credential tunnel")
	}
	if d.generation.Load() != 1 {
		t.Fatal("profile change did not invalidate in-flight discovery")
	}
	saved, err := clientcmd.LoadFromFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"user", "alias-user"} {
		profile, err := BrowserChrome.profileFor(saved.AuthInfos[name])
		if err != nil || profile.Name != "Work" || profile.Directory != "Profile 1" {
			t.Fatalf("alias profile %s: %+v %v", name, profile, err)
		}
		before, after := raw.AuthInfos[name].DeepCopy(), saved.AuthInfos[name].DeepCopy()
		before.Extensions, after.Extensions = nil, nil
		after.LocationOfOrigin = ""
		if !reflect.DeepEqual(before, after) {
			t.Fatalf("authentication fields changed for %s", name)
		}
		ext, _ := json.Marshal(saved.AuthInfos[name].Extensions[desktopExtension])
		if strings.Contains(string(ext), `"chromeProfiles"`) || !strings.Contains(string(ext), `"future":true`) {
			t.Fatalf("unrelated extension data changed: %s", ext)
		}
		other, _ := json.Marshal(saved.AuthInfos[name].Extensions["other.example/tool"])
		if string(other) != `{"keep":"me"}` {
			t.Fatalf("other extension changed: %s", other)
		}
	}
	if saved.CurrentContext != "two" || saved.Contexts["one/team"].Namespace != "team" || len(saved.AuthInfos["different-user"].Extensions) > 0 {
		t.Fatal("unrelated context/auth entry changed")
	}
	reloaded, _ := d.load()
	for _, g := range contextGroups(reloaded, BrowserChrome) {
		if g.Name == "one" && (g.Key != key || g.BrowserProfile == nil || g.BrowserProfile.Directory != "Profile 1") {
			t.Fatal("saving preference changed connection identity")
		}
	}
	prepared := saved.AuthInfos["user"].DeepCopy()
	if err := p.prepare(prepared, "https://api.one", key); err != nil {
		t.Fatal(err)
	}
	flags, _ := oidcLoginFlags(prepared.Exec)
	if flags["token-cache-dir"] == "" || flags["token-cache-storage"] != "" || flags["browser-command"] != p.helper {
		t.Fatalf("login not isolated/routed: %v", flags)
	}
	token := idToken(t, time.Now().Add(time.Hour))
	dir, record := fakeKubectl(t, token)
	t.Setenv("PATH", dir)
	if got, err := runOIDCLogin(context.Background(), prepared); err != nil || got != token {
		t.Fatalf("profile login: %v", err)
	}
	args, _ := os.ReadFile(record)
	if !strings.Contains(string(args), "--browser-command="+p.helper) || !strings.Contains(string(args), "Profile 1 1") {
		t.Fatalf("profile was not passed to kubelogin: %s", args)
	}
	second := saved.AuthInfos["user"].DeepCopy()
	if err := p.prepare(second, "https://api.one", "another-identity"); err != nil {
		t.Fatal(err)
	}
	if loginKey(prepared) == loginKey(second) {
		t.Fatal("different connection identities share a login cache")
	}
	if err := StaticCredentials(prepared, time.Now(), func(k string) string {
		if k == loginKey(second) {
			t.Fatal("cache identity crossed")
		}
		return token
	}); err != nil {
		t.Fatal(err)
	}
	if err := p.Set(d, key, "../../outside"); err == nil {
		t.Fatal("invalid profile directory saved")
	}
	if err := p.Set(d, key, ""); err != nil {
		t.Fatal(err)
	}
	cleared, _ := clientcmd.LoadFromFile(path)
	if profile, _ := BrowserChrome.profileFor(cleared.AuthInfos["user"]); profile.Directory != "" {
		t.Fatal("profile assignment was not removed")
	}

}

func TestChromeDesktopRoutesRequireSameOriginAndLaunchAssignedProfile(t *testing.T) {
	p := chromeFixture(t)
	d := New(&Config{KubeLogin: true, BrowserProfiles: p})
	defer d.Close()
	d.discovery.contexts = []DiscoveredContext{{Key: "identity", Status: "available", URL: "https://mcp.example/mcp", BrowserProfile: &BrowserProfile{Directory: "Profile 1", Name: "Work"}}}
	launched := 0
	p.launch = func(profile, target string, app bool) error {
		launched++
		if profile != "Profile 1" || target != "http://localhost:17843/settings?browser-profile=Profile+1&connect=identity" || !app {
			t.Fatalf("wrong launch: %s %s %v", profile, target, app)
		}
		return nil
	}
	for _, origin := range []string{"https://evil.example", "http://localhost:17843"} {
		r := httptest.NewRequest(http.MethodPost, "http://localhost:17843/api/desktop/connect", strings.NewReader(`{"key":"identity"}`))
		r.Header.Set("Origin", origin)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		d.Handler().ServeHTTP(w, r)
		want := http.StatusForbidden
		if origin == "http://localhost:17843" {
			want = http.StatusNoContent
		}
		if w.Code != want {
			t.Fatalf("launch status %d: %s", w.Code, w.Body.String())
		}
	}
	if launched != 1 {
		t.Fatal("untrusted origin launched browser")
	}
}

func TestChromeLaunchPreservesArgumentBoundaries(t *testing.T) {
	record := filepath.Join(t.TempDir(), "args")
	t.Setenv("CHROME_ARG_RECORD", record)
	command := filepath.Join(t.TempDir(), "fake-chrome")
	if err := os.WriteFile(command, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CHROME_ARG_RECORD\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "Browser Data")
	target := "https://auth.example/authorize?client_id=test&state=literal"
	if err := OpenBrowserProfile(BrowserChrome, command, root, "Profile 1", target, false); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	var body []byte
	for time.Now().Before(deadline) {
		body, _ = os.ReadFile(record)
		if len(body) > 0 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	want := "--user-data-dir=" + root + "\n--profile-directory=Profile 1\n--new-window\n" + target + "\n"
	if string(body) != want {
		t.Fatalf("browser arguments %q, want %q", body, want)
	}
	if err := OpenBrowserProfile(BrowserChrome, command, root, "../outside", target, false); err == nil {
		t.Fatal("invalid profile accepted")
	}
	if err := OpenBrowserProfile(BrowserChrome, command, root, "Default", "file:///etc/passwd", false); err == nil {
		t.Fatal("unsafe browser URL accepted")
	}
}

func TestBrowserProfileUpdatesOnlyAuthSourceInMergedKubeconfigs(t *testing.T) {
	p := chromeFixture(t)
	one, two := clientcmdapi.NewConfig(), clientcmdapi.NewConfig()
	one.Clusters["one"] = &clientcmdapi.Cluster{Server: "https://api.one"}
	one.AuthInfos["one"] = &clientcmdapi.AuthInfo{ClientCertificate: "relative.crt", ClientKey: "relative.key"}
	one.Contexts["one"] = &clientcmdapi.Context{Cluster: "one", AuthInfo: "one"}
	one.CurrentContext = "one"
	two.Clusters["two"] = &clientcmdapi.Cluster{Server: "https://api.two"}
	two.AuthInfos["two"] = &clientcmdapi.AuthInfo{Token: "second-file-token"}
	two.Contexts["two"] = &clientcmdapi.Context{Cluster: "two", AuthInfo: "two"}
	two.Contexts["one/team"] = &clientcmdapi.Context{Cluster: "one", AuthInfo: "one", Namespace: "team"}
	two.CurrentContext = "two"
	a, b := filepath.Join(t.TempDir(), "one"), filepath.Join(t.TempDir(), "two")
	if err := clientcmd.WriteToFile(*one, a); err != nil {
		t.Fatal(err)
	}
	if err := clientcmd.WriteToFile(*two, b); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(b)
	t.Setenv("KUBECONFIG", a+string(filepath.ListSeparator)+b)
	d := StartDiscovery(false, "", true, p)
	defer d.Close()
	raw, err := d.load()
	if err != nil {
		t.Fatal(err)
	}
	var key string
	for _, group := range contextGroups(raw, BrowserChrome) {
		if group.Name == "one" {
			key = group.Key
		}
	}
	if err := p.Set(d, key, "Profile 1"); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(b)
	if string(before) != string(after) {
		t.Fatal("saving the auth preference changed another kubeconfig file")
	}
	saved, err := clientcmd.LoadFromFile(a)
	if err != nil {
		t.Fatal(err)
	}
	profile, _ := BrowserChrome.profileFor(saved.AuthInfos["one"])
	if profile.Name != "Work" || saved.AuthInfos["one"].ClientCertificate != "relative.crt" || saved.CurrentContext != "one" {
		t.Fatal("auth source file was rewritten incorrectly")
	}
}

func TestAzureProfileDoesNotReceiveOIDCPluginFlags(t *testing.T) {
	p := chromeFixture(t)
	auth := &clientcmdapi.AuthInfo{Exec: &clientcmdapi.ExecConfig{Command: "kubelogin", Args: []string{"get-token", "--login", "azurecli", "--server-id", "server", "--tenant-id", "tenant"}}, Extensions: map[string]runtime.Object{desktopExtension: &runtime.Unknown{Raw: []byte(`{"chromeProfiles":{"https://api.qs":{"directory":"Profile 1","name":"Work"}}}`)}}}
	original := append([]string(nil), auth.Exec.Args...)
	if usesOIDCLogin(auth) {
		t.Fatal("Azure kubelogin mistaken for OIDC plugin")
	}
	if err := p.prepare(auth, "https://api.qs", "qs"); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(auth.Exec.Args, original) {
		t.Fatalf("Azure args changed: %v", auth.Exec.Args)
	}
	command, args, ok := cloudLoginCommand(auth)
	if !ok || command != "az" || !reflect.DeepEqual(args, []string{"login", "--tenant", "tenant", "--scope", "server/.default"}) {
		t.Fatal("native Azure flow changed", command, args)
	}
}

func TestInitialWindowUsesExistingLastActiveProfile(t *testing.T) {
	p := chromeFixture(t)
	if err := os.WriteFile(filepath.Join(p.root, "Local State"), []byte(`{"profile":{"last_used":"Profile 1"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	p.launch = func(profile, target string, app bool) error {
		if profile != "Profile 1" || target != "http://localhost:17843/settings?browser-profile=Profile+1" || !app {
			t.Fatal(profile, target, app)
		}
		return nil
	}
	if err := p.OpenSettings(); err != nil {
		t.Fatal(err)
	}
}

func TestPinnedLauncherUsesItsExistingProfile(t *testing.T) {
	p := chromeFixture(t)
	p.launch = func(profile, target string, app bool) error {
		if profile != "Profile 1" || target != "http://localhost:17843/settings?browser-profile=Profile+1" || !app {
			t.Fatal(profile, target, app)
		}
		return nil
	}
	if err := p.OpenSettings("Profile 1"); err != nil {
		t.Fatal(err)
	}
	if err := p.OpenSettings("Missing"); err == nil {
		t.Fatal("unknown profile would create a new browser identity")
	}
}

func TestDesktopRetryKeepsFailedContextAndWakesDiscovery(t *testing.T) {
	d := New(&Config{KubeLogin: true})
	defer d.Close()
	d.discovery.contexts = []DiscoveredContext{{Key: "failed", Name: "private", PortForward: true, Status: "MCP port-forward unavailable: context deadline exceeded"}}
	for _, origin := range []string{"https://other.example", "http://localhost:17843"} {
		request := httptest.NewRequest(http.MethodPost, "http://localhost:17843/api/desktop/retry", strings.NewReader(`{"key":"failed"}`))
		request.Header.Set("Origin", origin)
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		d.Handler().ServeHTTP(response, request)
		want := http.StatusForbidden
		if origin == "http://localhost:17843" {
			want = http.StatusNoContent
		}
		if response.Code != want {
			t.Fatal(response.Code, response.Body.String())
		}
	}
	contexts, _ := d.discovery.Snapshot()
	if len(contexts) != 1 || contexts[0].Status != "checking" || !contexts[0].PortForward {
		t.Fatal("retry lost failed connection", contexts)
	}
	select {
	case <-d.discovery.wake:
	default:
		t.Fatal("retry did not wake discovery")
	}
	if d.discovery.Retry("missing") {
		t.Fatal("unknown context accepted")
	}
}

func TestBrowserProfileIsSingleAssociationPerAuthEntry(t *testing.T) {
	auth := &clientcmdapi.AuthInfo{Extensions: map[string]runtime.Object{desktopExtension: &runtime.Unknown{Raw: []byte(`{"chromeProfile":{"directory":"Profile 1","name":"Work"}}`)}}}
	raw := clientcmdapi.NewConfig()
	raw.AuthInfos["shared"] = auth
	for _, name := range []string{"one", "two"} {
		raw.Clusters[name] = &clientcmdapi.Cluster{Server: "https://" + name}
		raw.Contexts[name] = &clientcmdapi.Context{Cluster: name, AuthInfo: "shared"}
	}
	for _, group := range contextGroups(raw, BrowserChrome) {
		if group.BrowserProfile == nil || group.BrowserProfile.Directory != "Profile 1" {
			t.Fatal("API server changed auth profile", group)
		}
	}
}

func TestChromeConnectPassesOnlyLocalReturnPathToNewProfile(t *testing.T) {
	p := chromeFixture(t)
	d := New(&Config{KubeLogin: true, BrowserProfiles: p})
	defer d.Close()
	d.discovery.contexts = []DiscoveredContext{{Key: "identity", Status: "available", URL: "https://mcp.example/mcp", BrowserProfile: &BrowserProfile{Directory: "Profile 1", Name: "Work"}}}
	launches := 0
	linked := "/topmost-owners/workload/pod?tab=metadata#details"
	p.launch = func(profile, target string, app bool) error {
		launches++
		u, err := url.Parse(target)
		if err != nil {
			t.Fatal(err)
		}
		if profile != "Profile 1" || !app || u.Scheme+"://"+u.Host != DesktopOrigin || u.Path != "/settings" || u.Query().Get("return-to") != linked || u.Query().Get("connect") != "identity" || u.Query().Get("browser-profile") != "Profile 1" {
			t.Fatalf("wrong launch %s", target)
		}
		return nil
	}
	for _, destination := range []string{linked, "https://evil.example", "//evil.example", "/\\evil.example", "/\n/evil.example"} {
		body, _ := json.Marshal(map[string]string{"key": "identity", "returnTo": destination})
		r := httptest.NewRequest(http.MethodPost, DesktopOrigin+"/api/desktop/connect", strings.NewReader(string(body)))
		r.Header.Set("Origin", DesktopOrigin)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		d.Handler().ServeHTTP(w, r)
		want := http.StatusBadRequest
		if destination == linked {
			want = http.StatusNoContent
		}
		if w.Code != want {
			t.Fatalf("destination %q: %d %s", destination, w.Code, w.Body)
		}
	}
	if launches != 1 {
		t.Fatalf("launched %d times", launches)
	}
}
