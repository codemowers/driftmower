package main

import (
	"testing"

	"github.com/codemowers/driftmower/desktop/dashboard"
)

func TestDefaultBrowserHandlers(t *testing.T) {
	for handler, want := range map[string]dashboard.Browser{
		"org.mozilla.firefox.desktop\n":                       dashboard.BrowserFirefox,
		"firefox_firefox.desktop":                             dashboard.BrowserFirefox,
		"google-chrome.desktop":                               dashboard.BrowserChrome,
		"chromium-browser.desktop":                            dashboard.BrowserChrome,
		"    ProgId    REG_SZ    FirefoxURL-308046B0AF4A39CB": dashboard.BrowserFirefox,
		`LSHandlerRoleAll = "com.google.chrome";`:             dashboard.BrowserChrome,
		"org.gnome.Epiphany.desktop":                          "",
		"":                                                    "",
	} {
		if got := classifyBrowser(handler); got != want {
			t.Fatalf("%q: %q, want %q", handler, got, want)
		}
	}
}
