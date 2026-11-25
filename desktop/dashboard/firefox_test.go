package dashboard

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

// firefoxFixture mirrors profiles.ini as written by Firefox: relative Paths
// with forward slashes, an absolute profile and an entry whose folder is gone.
func firefoxFixture(t *testing.T) (*BrowserProfiles, string) {
	t.Helper()
	root := t.TempDir()
	elsewhere := filepath.Join(t.TempDir(), "work-profile")
	for _, dir := range []string{filepath.Join(root, "Profiles", "abc.default-release"), filepath.Join(root, "old.default"), elsewhere} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	ini := "[Profile2]\nName=Gone\nIsRelative=1\nPath=missing.default\n\n" +
		"[Profile1]\nName=old\nIsRelative=1\nPath=old.default\nDefault=1\n\n" +
		"[Profile0]\nName=Personal\nIsRelative=1\nPath=Profiles/abc.default-release\n\n" +
		"[Profile3]\nName=Work\nIsRelative=0\nPath=" + elsewhere + "\n\n" +
		"[General]\nStartWithLastProfile=1\nVersion=2\n"
	if err := os.WriteFile(filepath.Join(root, "profiles.ini"), []byte(ini), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "installs.ini"), []byte("[11457493C5A56847]\nDefault=Profiles/abc.default-release\nLocked=1\n"), 0600); err != nil {
		t.Fatal(err)
	}
	p, err := NewBrowserProfiles(BrowserFirefox, "/fake/firefox", root)
	if err != nil {
		t.Fatal(err)
	}
	p.cache = filepath.Join(t.TempDir(), "cache")
	return p, elsewhere
}

func TestFirefoxProfilesComeFromProfilesINI(t *testing.T) {
	p, elsewhere := firefoxFixture(t)
	profiles, err := p.List()
	if err != nil {
		t.Fatal(err)
	}
	want := []BrowserProfile{{Directory: "Profiles/abc.default-release", Name: "Personal"}, {Directory: elsewhere, Name: "Work"}, {Directory: "old.default", Name: "old"}}
	body, _ := json.Marshal(profiles)
	wantBody, _ := json.Marshal(want)
	if string(body) != string(wantBody) {
		t.Fatalf("profiles %s, want %s", body, wantBody)
	}
	empty, err := NewBrowserProfiles(BrowserFirefox, "/fake/firefox", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if profiles, err := empty.List(); err != nil || len(profiles) != 0 {
		t.Fatal("missing profiles.ini is not an empty profile list", profiles, err)
	}
}

func TestFirefoxSettingsWindowFollowsInstallDefault(t *testing.T) {
	p, _ := firefoxFixture(t)
	p.launch = func(profile, target string, app bool) error {
		if profile != "Profiles/abc.default-release" || target != "http://localhost:17843/settings?browser-profile=Profiles%2Fabc.default-release" {
			t.Fatal(profile, target)
		}
		return nil
	}
	if err := p.OpenSettings(); err != nil {
		t.Fatal(err)
	}
	// Without installs.ini, profiles.ini's Default=1 entry is used.
	if err := os.Remove(filepath.Join(p.root, "installs.ini")); err != nil {
		t.Fatal(err)
	}
	p.launch = func(profile, target string, app bool) error {
		if profile != "old.default" {
			t.Fatal(profile, target)
		}
		return nil
	}
	if err := p.OpenSettings(); err != nil {
		t.Fatal(err)
	}
	if err := p.OpenSettings("missing.default"); err == nil {
		t.Fatal("a profile without its folder was opened")
	}
}

func TestFirefoxLaunchUsesOnlyListedProfiles(t *testing.T) {
	p, elsewhere := firefoxFixture(t)
	record := filepath.Join(t.TempDir(), "args")
	t.Setenv("FIREFOX_ARG_RECORD", record)
	command := filepath.Join(t.TempDir(), "fake-firefox")
	if err := os.WriteFile(command, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$FIREFOX_ARG_RECORD\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	target := "https://auth.example/authorize?client_id=test&state=literal"
	for profile, want := range map[string]string{
		"Profiles/abc.default-release": "--profile\n" + filepath.Join(p.root, "Profiles", "abc.default-release") + "\n--new-window\n" + target + "\n",
		elsewhere:                      "--profile\n" + elsewhere + "\n--new-window\n" + target + "\n",
		"":                             "--new-window\n" + target + "\n",
	} {
		_ = os.Remove(record)
		if err := OpenBrowserProfile(BrowserFirefox, command, p.root, profile, target, true); err != nil {
			t.Fatal(err)
		}
		var body []byte
		for deadline := time.Now().Add(time.Second); time.Now().Before(deadline) && len(body) == 0; time.Sleep(time.Millisecond) {
			body, _ = os.ReadFile(record)
		}
		if string(body) != want {
			t.Fatalf("profile %q: arguments %q, want %q", profile, body, want)
		}
	}
	for _, profile := range []string{"../outside", t.TempDir(), "missing.default"} {
		if err := OpenBrowserProfile(BrowserFirefox, command, p.root, profile, target, false); err == nil {
			t.Fatalf("unlisted profile %q accepted", profile)
		}
	}
	if err := OpenBrowserProfile(BrowserFirefox, command, p.root, "old.default", "file:///etc/passwd", false); err == nil {
		t.Fatal("unsafe browser URL accepted")
	}
}

func TestFirefoxAssignmentIsSeparateFromChrome(t *testing.T) {
	p, _ := firefoxFixture(t)
	raw := clientcmdapi.NewConfig()
	raw.Clusters["one"] = &clientcmdapi.Cluster{Server: "https://api.one"}
	auth := oidcUser()
	auth.Extensions = map[string]runtime.Object{desktopExtension: &runtime.Unknown{Raw: []byte(`{"chromeProfile":{"directory":"Profile 1","name":"Work"},"sshJumpHost":"kept"}`)}}
	raw.AuthInfos["user"] = auth
	raw.Contexts["one"] = &clientcmdapi.Context{Cluster: "one", AuthInfo: "user"}
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
	groups := contextGroups(resolved, BrowserFirefox)
	if len(groups) != 1 || groups[0].BrowserProfile != nil {
		t.Fatal("a Chrome assignment was read as a Firefox profile", groups)
	}
	if err := p.Set(d, groups[0].Key, "Profiles/abc.default-release"); err != nil {
		t.Fatal(err)
	}
	saved, err := clientcmd.LoadFromFile(path)
	if err != nil {
		t.Fatal(err)
	}
	firefox, _ := BrowserFirefox.profileFor(saved.AuthInfos["user"])
	chrome, _ := BrowserChrome.profileFor(saved.AuthInfos["user"])
	if firefox.Directory != "Profiles/abc.default-release" || firefox.Name != "Personal" || chrome.Directory != "Profile 1" {
		t.Fatalf("assignments firefox=%+v chrome=%+v", firefox, chrome)
	}
	ext, _ := json.Marshal(saved.AuthInfos["user"].Extensions[desktopExtension])
	if !strings.Contains(string(ext), `"firefoxProfile"`) || !strings.Contains(string(ext), `"sshJumpHost":"kept"`) {
		t.Fatalf("extension %s", ext)
	}

	prepared := saved.AuthInfos["user"].DeepCopy()
	if err := p.prepare(prepared, "https://api.one", groups[0].Key); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{}
	for _, v := range prepared.Exec.Env {
		env[v.Name] = v.Value
	}
	if env["DRIFTMOWER_BROWSER"] != "firefox" || env["DRIFTMOWER_BROWSER_PROFILE"] != "Profiles/abc.default-release" || env["DRIFTMOWER_BROWSER_ROOT"] != p.root || env["BROWSER"] != p.helper {
		t.Fatalf("helper environment %v", env)
	}

	if err := p.Set(d, groups[0].Key, ""); err != nil {
		t.Fatal(err)
	}
	cleared, _ := clientcmd.LoadFromFile(path)
	if profile, _ := BrowserFirefox.profileFor(cleared.AuthInfos["user"]); profile.Directory != "" {
		t.Fatal("Firefox assignment not cleared")
	}
	if profile, _ := BrowserChrome.profileFor(cleared.AuthInfos["user"]); profile.Directory != "Profile 1" {
		t.Fatal("clearing Firefox removed the Chrome assignment")
	}
}

func TestParseBrowser(t *testing.T) {
	for name, want := range map[string]Browser{"chrome": BrowserChrome, "Chromium": BrowserChrome, "google-chrome": BrowserChrome, "firefox": BrowserFirefox} {
		if got, err := ParseBrowser(name); err != nil || got != want {
			t.Fatal(name, got, err)
		}
	}
	if _, err := ParseBrowser("safari"); err == nil {
		t.Fatal("unsupported browser accepted")
	}
}
