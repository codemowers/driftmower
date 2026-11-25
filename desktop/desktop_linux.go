package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/codemowers/driftmower/desktop/dashboard"
)

// Chrome's Wayland app ID comes from the app URL's host/path and profile
// directory. Match that ID so GNOME finds our icon even in an existing Chrome
// process. Query parameters (including connection/profile selection) do not
// affect it. See Chromium's GetXdgAppIdForWebApp/GetShortcutFileName.
// Firefox windows always carry Firefox's own app ID, so only the launcher is
// installed for it. A browser chosen with --browser is kept in the launcher.
func installDesktop(profiles *dashboard.BrowserProfiles, binary, browser string) error {
	data := os.Getenv("XDG_DATA_HOME")
	if !filepath.IsAbs(data) {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		data = filepath.Join(home, ".local", "share")
	}
	applications := filepath.Join(data, "applications")
	icons := filepath.Join(data, "icons", "hicolor", "scalable", "apps")
	for _, dir := range []string{applications, icons} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return err
		}
	}
	if err := os.WriteFile(filepath.Join(icons, "driftmower.svg"), desktopIcon, 0644); err != nil {
		return err
	}
	chrome := profiles.Kind() == dashboard.BrowserChrome
	var existing []dashboard.BrowserProfile
	if chrome {
		var err error
		if existing, err = profiles.List(); err != nil {
			return err
		}
	}
	entries := []struct{ file, name, profile string }{{"driftmower.desktop", "Driftmower", ""}}
	for _, profile := range existing {
		id := strings.NewReplacer(" ", "_", "/", "_", "\\", "_").Replace(profile.Directory)
		entries = append(entries, struct{ file, name, profile string }{"chrome-localhost__settings-" + id + ".desktop", "Driftmower (" + profile.Name + ")", profile.Directory})
	}
	for _, entry := range entries {
		args := []string{binary}
		if browser != "" {
			args = append(args, "--browser="+browser)
		}
		if entry.profile != "" {
			args = append(args, "--browser-profile="+entry.profile)
		}
		name := strings.NewReplacer("\n", " ", "\r", " ", "\\", "\\\\").Replace(entry.name)
		hidden := ""
		if entry.profile != "" {
			hidden = "NoDisplay=true\n"
		}
		windowClass := ""
		if chrome {
			windowClass = "StartupWMClass=localhost__settings\n"
		}
		body := fmt.Sprintf("[Desktop Entry]\nVersion=1.0\nType=Application\nName=%s\nComment=Kubernetes cluster dashboard\nExec=%s\nIcon=driftmower\nTerminal=false\nCategories=Development;\n%s%s", name, desktopExec(args), windowClass, hidden)
		if err := os.WriteFile(filepath.Join(applications, entry.file), []byte(body), 0644); err != nil {
			return err
		}
	}
	if updater, err := exec.LookPath("update-desktop-database"); err == nil {
		if output, err := exec.Command(updater, applications).CombinedOutput(); err != nil {
			return fmt.Errorf("refresh desktop launchers: %w: %s", err, output)
		}
	}
	return nil
}

// Desktop entries have both key-value escaping and Exec argument escaping;
// percent signs are field codes even inside double quotes.
func desktopExec(args []string) string {
	quoted := make([]string, len(args))
	escape := strings.NewReplacer("\\", "\\\\", "\"", "\\\"", "`", "\\`", "$", "\\$", "%", "%%")
	for i, arg := range args {
		quoted[i] = "\"" + escape.Replace(arg) + "\""
	}
	return strings.ReplaceAll(strings.Join(quoted, " "), "\\", "\\\\")
}
