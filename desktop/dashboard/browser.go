package dashboard

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"

	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

const desktopExtension = "driftmower.codemowers.io/desktop"

// Browser is the browser family the desktop opens. Chromium uses Chrome's
// profile layout and command-line switches, so it shares BrowserChrome.
type Browser string

const (
	BrowserChrome  Browser = "chrome"
	BrowserFirefox Browser = "firefox"
)

func ParseBrowser(name string) (Browser, error) {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "chrome", "google-chrome", "chromium":
		return BrowserChrome, nil
	case "firefox":
		return BrowserFirefox, nil
	}
	return "", fmt.Errorf("unsupported browser %q: use chrome, chromium or firefox", name)
}

func (b Browser) Name() string {
	if b == BrowserFirefox {
		return "Firefox"
	}
	return "Chrome"
}

// Each browser family keeps its own kubeconfig assignment, so switching the
// desktop between browsers never reinterprets one browser's profile folder.
func (b Browser) extensionField() string {
	if b == BrowserFirefox {
		return "firefoxProfile"
	}
	return "chromeProfile"
}

type BrowserProfile struct {
	Directory string `json:"directory"`
	Name      string `json:"name"`
}

// BrowserProfiles reads only profile names/directories, never cookies or
// tokens. The assignment itself lives in the kubeconfig auth entry's extension.
type BrowserProfiles struct {
	kind                         Browser
	browser, root, helper, cache string
	mu                           sync.Mutex
	launch                       func(string, string, bool) error
}

func NewBrowserProfiles(kind Browser, browser, root string) (*BrowserProfiles, error) {
	if root == "" {
		var err error
		if kind == BrowserFirefox {
			root, err = firefoxRoot()
		} else {
			root, err = chromeRoot(browser)
		}
		if err != nil {
			return nil, err
		}
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	root = absolute
	helper, err := os.Executable()
	if err != nil {
		return nil, err
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		return nil, err
	}
	p := &BrowserProfiles{kind: kind, browser: browser, root: root, helper: helper, cache: filepath.Join(cache, "driftmower", "kubelogin")}
	p.launch = func(profile, target string, app bool) error {
		return OpenBrowserProfile(kind, browser, root, profile, target, app)
	}
	return p, nil
}

func (p *BrowserProfiles) Kind() Browser { return p.kind }

func chromeRoot(browser string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	chromium := strings.Contains(strings.ToLower(browser), "chromium")
	switch runtime.GOOS {
	case "darwin":
		if chromium {
			return filepath.Join(home, "Library", "Application Support", "Chromium"), nil
		}
		return filepath.Join(home, "Library", "Application Support", "Google", "Chrome"), nil
	case "windows":
		if chromium {
			return filepath.Join(os.Getenv("LOCALAPPDATA"), "Chromium", "User Data"), nil
		}
		return filepath.Join(os.Getenv("LOCALAPPDATA"), "Google", "Chrome", "User Data"), nil
	}
	config, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	if chromium {
		return filepath.Join(config, "chromium"), nil
	}
	return filepath.Join(config, "google-chrome"), nil
}

// firefoxRoot is the directory holding profiles.ini. Linux Firefox has used
// ~/.mozilla/firefox and now prefers the XDG config directory; Snap packages
// keep their own copy.
func firefoxRoot() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	var candidates []string
	switch runtime.GOOS {
	case "darwin":
		candidates = []string{filepath.Join(home, "Library", "Application Support", "Firefox")}
	case "windows":
		candidates = []string{filepath.Join(os.Getenv("APPDATA"), "Mozilla", "Firefox")}
	default:
		if config, err := os.UserConfigDir(); err == nil {
			candidates = append(candidates, filepath.Join(config, "mozilla", "firefox"))
		}
		candidates = append(candidates, filepath.Join(home, ".mozilla", "firefox"), filepath.Join(home, "snap", "firefox", "common", ".mozilla", "firefox"))
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(filepath.Join(candidate, "profiles.ini")); err == nil && !info.IsDir() {
			return candidate, nil
		}
	}
	return candidates[0], nil
}

func (p *BrowserProfiles) List() ([]BrowserProfile, error) {
	if p.kind == BrowserFirefox {
		return listFirefoxProfiles(p.root)
	}
	body, err := os.ReadFile(filepath.Join(p.root, "Local State"))
	if os.IsNotExist(err) {
		return []BrowserProfile{}, nil
	}
	if err != nil {
		return nil, err
	}
	var state struct {
		Profile struct {
			Info map[string]struct {
				Name string `json:"name"`
			} `json:"info_cache"`
		} `json:"profile"`
	}
	if err := json.Unmarshal(body, &state); err != nil {
		return nil, fmt.Errorf("cannot read Chrome profile names: %w", err)
	}
	out := []BrowserProfile{}
	for directory, profile := range state.Profile.Info {
		if !validProfileDirectory(directory) {
			continue
		}
		info, err := os.Stat(filepath.Join(p.root, directory))
		if err != nil || !info.IsDir() {
			continue
		}
		name := profile.Name
		if name == "" {
			name = directory
		}
		out = append(out, BrowserProfile{Directory: directory, Name: name})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

type iniSection struct {
	name   string
	values map[string]string
}

func readINI(path string) ([]iniSection, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var sections []iniSection
	scanner := bufio.NewScanner(bytes.NewReader(body))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		switch {
		case line == "" || strings.HasPrefix(line, ";") || strings.HasPrefix(line, "#"):
		case strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]"):
			sections = append(sections, iniSection{name: line[1 : len(line)-1], values: map[string]string{}})
		case len(sections) > 0:
			if key, value, ok := strings.Cut(line, "="); ok {
				sections[len(sections)-1].values[strings.TrimSpace(key)] = strings.TrimSpace(value)
			}
		}
	}
	return sections, scanner.Err()
}

// Firefox identifies a profile by its Path in profiles.ini: relative to the
// profiles.ini directory (with forward slashes) unless IsRelative=0.
func listFirefoxProfiles(root string) ([]BrowserProfile, error) {
	sections, err := readINI(filepath.Join(root, "profiles.ini"))
	if os.IsNotExist(err) {
		return []BrowserProfile{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("cannot read Firefox profile names: %w", err)
	}
	out := []BrowserProfile{}
	for _, section := range sections {
		if !strings.HasPrefix(section.name, "Profile") || section.values["Path"] == "" {
			continue
		}
		directory := section.values["Path"]
		if info, err := os.Stat(firefoxProfilePath(root, directory, section.values["IsRelative"] != "0")); err != nil || !info.IsDir() {
			continue
		}
		name := section.values["Name"]
		if name == "" {
			name = directory
		}
		out = append(out, BrowserProfile{Directory: directory, Name: name})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func firefoxProfilePath(root, directory string, relative bool) string {
	if relative {
		return filepath.Join(root, filepath.FromSlash(directory))
	}
	return directory
}

// resolveFirefoxProfile accepts only a Path listed in profiles.ini, so a
// kubeconfig value or helper argument cannot point Firefox at another folder.
func resolveFirefoxProfile(root, directory string) (string, error) {
	sections, err := readINI(filepath.Join(root, "profiles.ini"))
	if err != nil {
		return "", fmt.Errorf("cannot read Firefox profiles: %w", err)
	}
	for _, section := range sections {
		if strings.HasPrefix(section.name, "Profile") && section.values["Path"] == directory && directory != "" {
			path := firefoxProfilePath(root, directory, section.values["IsRelative"] != "0")
			if info, err := os.Stat(path); err != nil || !info.IsDir() {
				return "", errors.New("assigned Firefox profile no longer exists")
			}
			return path, nil
		}
	}
	return "", errors.New("Firefox profile no longer exists")
}

// defaultFirefoxProfile follows installs.ini, which records the profile each
// Firefox installation opens, and falls back to profiles.ini's Default=1.
func defaultFirefoxProfile(root string) string {
	selected := ""
	if installs, err := readINI(filepath.Join(root, "installs.ini")); err == nil {
		for _, install := range installs {
			if value := install.values["Default"]; value != "" {
				if selected != "" && selected != value {
					selected = ""
					break
				}
				selected = value
			}
		}
	}
	if selected != "" {
		return selected
	}
	if sections, err := readINI(filepath.Join(root, "profiles.ini")); err == nil {
		for _, section := range sections {
			if strings.HasPrefix(section.name, "Profile") && section.values["Default"] == "1" {
				return section.values["Path"]
			}
		}
	}
	return ""
}

// OpenSettings uses the browser's last active or default existing profile and
// tells the window which profile it belongs to, so same-profile connections
// reuse that window.
func (p *BrowserProfiles) OpenSettings(preferred ...string) error {
	if len(preferred) > 0 && preferred[0] != "" {
		profiles, err := p.List()
		if err != nil {
			return err
		}
		for _, profile := range profiles {
			if profile.Directory == preferred[0] {
				return p.launch(profile.Directory, settingsURL(url.Values{"browser-profile": {profile.Directory}}), true)
			}
		}
		return fmt.Errorf("%s profile no longer exists", p.kind.Name())
	}
	if p.kind == BrowserFirefox {
		profile := defaultFirefoxProfile(p.root)
		if _, err := resolveFirefoxProfile(p.root, profile); err != nil {
			// Without a known profile Firefox chooses one itself, and the
			// window cannot claim a profile it may not be using.
			return p.launch("", settingsURL(nil), true)
		}
		return p.launch(profile, settingsURL(url.Values{"browser-profile": {profile}}), true)
	}
	profile := "Default"
	body, err := os.ReadFile(filepath.Join(p.root, "Local State"))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err == nil {
		var state struct {
			Profile struct {
				LastUsed string `json:"last_used"`
			} `json:"profile"`
		}
		if err := json.Unmarshal(body, &state); err != nil {
			return err
		}
		if validProfileDirectory(state.Profile.LastUsed) {
			profile = state.Profile.LastUsed
		}
	}
	return p.launch(profile, settingsURL(url.Values{"browser-profile": {profile}}), true)
}

func settingsURL(query url.Values) string {
	if len(query) == 0 {
		return DesktopOrigin + "/settings"
	}
	return DesktopOrigin + "/settings?" + query.Encode()
}

func validProfileDirectory(name string) bool {
	return name != "" && name != "." && name != ".." && filepath.Base(name) == name && !strings.ContainsAny(name, "/\\\x00")
}

// profileFor reads this browser family's assignment from the auth entry.
func (b Browser) profileFor(auth *clientcmdapi.AuthInfo) (BrowserProfile, error) {
	if auth == nil || b == "" {
		return BrowserProfile{}, nil
	}
	preferences := map[string]json.RawMessage{}
	if extension := auth.Extensions[desktopExtension]; extension != nil {
		body, err := json.Marshal(extension)
		if err != nil {
			return BrowserProfile{}, err
		}
		if err = json.Unmarshal(body, &preferences); err != nil {
			return BrowserProfile{}, fmt.Errorf("invalid %s extension: %w", desktopExtension, err)
		}
	}
	if body := preferences[b.extensionField()]; len(body) > 0 && string(body) != "null" {
		var profile BrowserProfile
		if err := json.Unmarshal(body, &profile); err != nil {
			return BrowserProfile{}, fmt.Errorf("invalid %s extension: %w", desktopExtension, err)
		}
		return profile, nil
	}
	if b != BrowserChrome || len(preferences["chromeProfiles"]) == 0 {
		return BrowserProfile{}, nil
	}
	// Read unambiguous legacy associations without keeping API-scoped semantics.
	var legacy map[string]BrowserProfile
	if err := json.Unmarshal(preferences["chromeProfiles"], &legacy); err != nil {
		return BrowserProfile{}, fmt.Errorf("invalid %s extension: %w", desktopExtension, err)
	}
	var selected BrowserProfile
	for _, profile := range legacy {
		if selected.Directory != "" && selected.Directory != profile.Directory {
			return BrowserProfile{}, nil
		}
		selected = profile
	}
	return selected, nil
}

func (p *BrowserProfiles) Set(discovery *ContextDiscovery, key, directory string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	var selected BrowserProfile
	if directory != "" {
		profiles, err := p.List()
		if err != nil {
			return err
		}
		for _, profile := range profiles {
			if profile.Directory == directory {
				selected = profile
			}
		}
		if selected.Directory == "" {
			return fmt.Errorf("%s profile no longer exists", p.kind.Name())
		}
	}
	access := clientcmd.NewDefaultPathOptions()
	if discovery.path != "" {
		access.LoadingRules.ExplicitPath = discovery.path
	}
	raw, err := access.GetStartingConfig()
	if err != nil {
		return err
	}
	resolved, err := discovery.load()
	if err != nil {
		return err
	}
	var group *DiscoveredContext
	for _, g := range contextGroups(resolved, p.kind) {
		if g.Key == key {
			copy := g
			group = &copy
			break
		}
	}
	if group == nil {
		return errors.New("connection no longer exists")
	}
	seen := map[string]bool{}
	for _, alias := range group.Aliases {
		name := raw.Contexts[alias.Name].AuthInfo
		if seen[name] {
			continue
		}
		seen[name] = true
		auth := raw.AuthInfos[name]
		if auth == nil {
			return errors.New("this connection has no kubeconfig auth entry")
		}
		// Preserve other extension fields, including the other browser's
		// assignment and fields written by a future Driftmower version, and
		// every unrelated kubeconfig setting.
		extension := map[string]json.RawMessage{}
		if old := auth.Extensions[desktopExtension]; old != nil {
			body, err := json.Marshal(old)
			if err != nil {
				return err
			}
			if err = json.Unmarshal(body, &extension); err != nil {
				return err
			}
		}
		if extension == nil {
			extension = map[string]json.RawMessage{}
		}
		if p.kind == BrowserChrome {
			delete(extension, "chromeProfiles")
		}
		if directory == "" {
			delete(extension, p.kind.extensionField())
		} else {
			body, err := json.Marshal(selected)
			if err != nil {
				return err
			}
			extension[p.kind.extensionField()] = body
		}
		body, err := json.Marshal(extension)

		if err != nil {
			return err
		}
		if auth.Extensions == nil {
			auth.Extensions = map[string]k8sruntime.Object{}
		}
		auth.Extensions[desktopExtension] = &k8sruntime.Unknown{Raw: body}
	}
	if err := clientcmd.ModifyConfig(access, *raw, false); err != nil {
		return err
	}
	discovery.mu.Lock()
	discovery.generation.Add(1)
	for i := range discovery.contexts {
		if discovery.contexts[i].Key == key {
			if directory == "" {
				discovery.contexts[i].BrowserProfile = nil
			} else {
				copy := selected
				discovery.contexts[i].BrowserProfile = &copy
			}
			discovery.contexts[i].Status = "checking"
		}
	}
	discovery.mu.Unlock()
	discovery.notify()
	if discovery.forwards != nil {
		discovery.forwards.drop(forwardIdentityKey(key, group.BrowserProfile))
	}
	select {
	case discovery.wake <- struct{}{}:
	default:
	}
	return nil
}

// Only the explicit desktop login clones get these overrides. The source
// kubeconfig and kubectl's own cache/browser settings are left untouched.
func (p *BrowserProfiles) prepare(auth *clientcmdapi.AuthInfo, server, key string) error {
	profile, err := p.kind.profileFor(auth)
	if err != nil {
		return err
	}
	if profile.Directory == "" || auth == nil || auth.Exec == nil {
		return nil
	}
	if p.kind == BrowserFirefox {
		if _, err := resolveFirefoxProfile(p.root, profile.Directory); err != nil {
			return err
		}
	} else {
		if !validProfileDirectory(profile.Directory) {
			return errors.New("invalid Chrome profile directory")
		}
		if info, err := os.Stat(filepath.Join(p.root, profile.Directory)); err != nil || !info.IsDir() {
			return errors.New("assigned Chrome profile no longer exists")
		}
	}
	if usesOIDCLogin(auth) {
		sum := sha256.Sum256([]byte(key + "\x00" + p.root + "\x00" + profile.Directory))
		cache := filepath.Join(p.cache, hex.EncodeToString(sum[:]))
		auth.Exec.Args = setExecFlag(auth.Exec.Args, "token-cache-dir", cache)
		auth.Exec.Args = setExecFlag(auth.Exec.Args, "token-cache-storage", "")
		auth.Exec.Args = setExecFlag(auth.Exec.Args, "browser-command", p.helper)
	}
	// AWS/Azure CLI browser launchers also honor BROWSER where supported.
	for name, value := range map[string]string{"BROWSER": p.helper, "DRIFTMOWER_OPEN_AUTH_URL": "1", "DRIFTMOWER_BROWSER": string(p.kind), "DRIFTMOWER_BROWSER_BINARY": p.browser, "DRIFTMOWER_BROWSER_ROOT": p.root, "DRIFTMOWER_BROWSER_PROFILE": profile.Directory} {
		auth.Exec.Env = append(auth.Exec.Env, clientcmdapi.ExecEnvVar{Name: name, Value: value})
	}
	return nil
}

func setExecFlag(args []string, name, value string) []string {
	flag := "--" + name
	out := make([]string, 0, len(args)+1)
	for i := 0; i < len(args); i++ {
		if args[i] == flag {
			if i+1 < len(args) {
				i++
			}
			continue
		}
		if strings.HasPrefix(args[i], flag+"=") {
			continue
		}
		out = append(out, args[i])
	}
	if value == "" {
		return out
	}
	return append(out, flag+"="+value)
}

// OpenBrowserProfile opens target in a new window of an existing profile.
// Chrome can open an application window; Firefox has no application mode,
// so app only affects Chrome. An empty Firefox profile lets Firefox choose.
func OpenBrowserProfile(kind Browser, browser, root, profile, target string, app bool) error {
	u, err := url.Parse(target)
	if err != nil || u.Host == "" || u.User != nil {
		return errors.New("invalid browser URL")
	}
	if u.Scheme != "https" {
		ip := net.ParseIP(u.Hostname())
		if u.Scheme != "http" || (u.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback())) {
			return errors.New("browser URL must use HTTPS or loopback HTTP")
		}
	}
	var args []string
	if kind == BrowserFirefox {
		if profile != "" {
			path, err := resolveFirefoxProfile(root, profile)
			if err != nil {
				return err
			}
			args = append(args, "--profile", path)
		}
		args = append(args, "--new-window", target)
	} else {
		if !validProfileDirectory(profile) {
			return errors.New("invalid Chrome profile directory")
		}
		args = []string{"--user-data-dir=" + root, "--profile-directory=" + profile, "--new-window"}
		if app {
			args = append(args, "--app="+target)
		} else {
			args = append(args, target)
		}
	}
	cmd := exec.Command(browser, args...)
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
