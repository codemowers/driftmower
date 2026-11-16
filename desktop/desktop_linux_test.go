package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/codemowers/driftmower/desktop/dashboard"
)

func TestDesktopEntriesMatchChromeWaylandProfiles(t *testing.T) {
	data := t.TempDir()
	t.Setenv("XDG_DATA_HOME", data)
	root := t.TempDir()
	for _, profile := range []string{"Default", "Profile 4"} {
		if err := os.Mkdir(filepath.Join(root, profile), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "Local State"), []byte(`{"profile":{"info_cache":{"Default":{"name":"Personal"},"Profile 4":{"name":"Work"}}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	profiles, err := dashboard.NewChromeProfiles("google-chrome", root)
	if err != nil {
		t.Fatal(err)
	}
	if err := installDesktop(profiles, "/opt/Driftmower App/driftmower-desktop"); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"driftmower.desktop", "chrome-localhost__settings-Default.desktop", "chrome-localhost__settings-Profile_4.desktop"} {
		path := filepath.Join(data, "applications", name)
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, expected := range []string{"Icon=driftmower", `Exec="/opt/Driftmower App/driftmower-desktop"`, "StartupWMClass=localhost__settings", "Terminal=false"} {
			if !strings.Contains(string(body), expected) {
				t.Fatalf("%s missing %s: %s", name, expected, body)
			}
		}
		if name == "chrome-localhost__settings-Profile_4.desktop" && !strings.Contains(string(body), `"--chrome-profile=Profile 4"`) {
			t.Fatalf("profile selection lost: %s", body)
		}
		if validate, err := exec.LookPath("desktop-file-validate"); err == nil {
			if output, err := exec.Command(validate, path).CombinedOutput(); err != nil {
				t.Fatalf("invalid launcher: %s: %v", output, err)
			}
		}
	}
	if _, err := os.Stat(filepath.Join(data, "icons/hicolor/scalable/apps/driftmower.svg")); err != nil {
		t.Fatal(err)
	}
}
