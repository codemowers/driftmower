package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/codemowers/driftmower/desktop/dashboard"
)

// findBrowser returns the requested browser, or else the system default
// browser when it is Chrome, Chromium or Firefox, or else whichever of them
// is installed (Chrome first). An explicitly requested browser must exist.
func findBrowser(requested string) (dashboard.Browser, string, error) {
	if requested != "" {
		kind, err := dashboard.ParseBrowser(requested)
		if err != nil {
			return "", "", err
		}
		chromium := strings.EqualFold(requested, "chromium")
		if path := browserBinary(kind, chromium); path != "" {
			return kind, path, nil
		}
		return "", "", fmt.Errorf("%s is not installed", requested)
	}
	order := []dashboard.Browser{dashboard.BrowserChrome, dashboard.BrowserFirefox}
	if defaultBrowser() == dashboard.BrowserFirefox {
		order = []dashboard.Browser{dashboard.BrowserFirefox, dashboard.BrowserChrome}
	}
	for _, kind := range order {
		if path := browserBinary(kind, false); path != "" {
			return kind, path, nil
		}
	}
	return "", "", errors.New("google Chrome, Chromium or Firefox is required")
}

// browserBinary prefers Google Chrome over Chromium unless Chromium is asked for.
func browserBinary(kind dashboard.Browser, chromium bool) string {
	var candidates []string
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "darwin":
		apps := []string{"Google Chrome.app/Contents/MacOS/Google Chrome", "Chromium.app/Contents/MacOS/Chromium"}
		if chromium {
			apps = apps[1:]
		}
		if kind == dashboard.BrowserFirefox {
			apps = []string{"Firefox.app/Contents/MacOS/firefox"}
		}
		for _, app := range apps {
			candidates = append(candidates, filepath.Join("/Applications", app), filepath.Join(home, "Applications", app))
		}
	case "windows":
		var paths []string
		switch {
		case kind == dashboard.BrowserFirefox:
			paths = []string{`Mozilla Firefox\firefox.exe`}
		case chromium:
			paths = []string{`Chromium\Application\chrome.exe`}
		default:
			paths = []string{`Google\Chrome\Application\chrome.exe`, `Chromium\Application\chrome.exe`}
		}
		for _, path := range paths {
			for _, env := range []string{"ProgramFiles", "ProgramFiles(x86)", "LocalAppData"} {
				if dir := os.Getenv(env); dir != "" {
					candidates = append(candidates, filepath.Join(dir, path))
				}
			}
		}
	default:
		names := []string{"google-chrome-stable", "google-chrome", "chromium", "chromium-browser"}
		if chromium {
			names = names[2:]
		}
		if kind == dashboard.BrowserFirefox {
			names = []string{"firefox", "firefox-esr"}
		}
		for _, name := range names {
			if path, err := exec.LookPath(name); err == nil {
				candidates = append(candidates, path)
			}
		}
	}
	for _, c := range candidates {
		if info, err := os.Stat(c); err == nil && !info.IsDir() {
			return c
		}
	}
	return ""
}

// defaultBrowser reports the system's default web browser family, or "" when
// it is unknown or another browser.
func defaultBrowser() dashboard.Browser {
	var output []byte
	switch runtime.GOOS {
	case "darwin":
		output = macOSHTTPSHandler()
	case "windows":
		output, _ = exec.Command("reg", "query", `HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice`, "/v", "ProgId").Output()
	default:
		var err error
		if output, err = exec.Command("xdg-settings", "get", "default-web-browser").Output(); err != nil || len(strings.TrimSpace(string(output))) == 0 {
			output, _ = exec.Command("xdg-mime", "query", "default", "x-scheme-handler/https").Output()
		}
	}
	return classifyBrowser(string(output))
}

func classifyBrowser(handler string) dashboard.Browser {
	handler = strings.ToLower(handler)
	switch {
	case strings.Contains(handler, "firefox"):
		return dashboard.BrowserFirefox
	case strings.Contains(handler, "chrome"), strings.Contains(handler, "chromium"):
		return dashboard.BrowserChrome
	}
	return ""
}

// macOSHTTPSHandler returns the LaunchServices entry for https, which names
// the default browser's bundle identifier.
func macOSHTTPSHandler() []byte {
	output, err := exec.Command("defaults", "read", "com.apple.LaunchServices/com.apple.launchservices.secure", "LSHandlers").Output()
	if err != nil {
		return nil
	}
	for _, entry := range strings.Split(string(output), "}") {
		if strings.Contains(entry, "LSHandlerURLScheme = https;") {
			return []byte(entry)
		}
	}
	return nil
}
