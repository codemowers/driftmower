package dashboard

import (
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

type ChromeProfile struct {
	Directory string `json:"directory"`
	Name      string `json:"name"`
}

type desktopPreferences struct {
	ChromeProfile  *ChromeProfile           `json:"chromeProfile,omitempty"`
	ChromeProfiles map[string]ChromeProfile `json:"chromeProfiles,omitempty"`
}

// ChromeProfiles reads only profile names/directories, never cookies or tokens.
// The assignment itself lives in the kubeconfig auth entry's extension.
type ChromeProfiles struct {
	browser, root, helper, cache string
	mu                           sync.Mutex
	launch                       func(string, string, bool) error
}

func NewChromeProfiles(browser, root string) (*ChromeProfiles, error) {
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		chromium := strings.Contains(strings.ToLower(browser), "chromium")
		switch runtime.GOOS {
		case "darwin":
			root = filepath.Join(home, "Library", "Application Support", "Google", "Chrome")
			if chromium {
				root = filepath.Join(home, "Library", "Application Support", "Chromium")
			}
		case "windows":
			root = filepath.Join(os.Getenv("LOCALAPPDATA"), "Google", "Chrome", "User Data")
			if chromium {
				root = filepath.Join(os.Getenv("LOCALAPPDATA"), "Chromium", "User Data")
			}
		default:
			config, err := os.UserConfigDir()
			if err != nil {
				return nil, err
			}
			root = filepath.Join(config, "google-chrome")
			if chromium {
				root = filepath.Join(config, "chromium")
			}
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
	p := &ChromeProfiles{browser: browser, root: root, helper: helper, cache: filepath.Join(cache, "driftmower", "kubelogin")}
	p.launch = func(profile, target string, app bool) error {
		return OpenChromeProfile(browser, root, profile, target, app)
	}
	return p, nil
}

func (p *ChromeProfiles) List() ([]ChromeProfile, error) {
	body, err := os.ReadFile(filepath.Join(p.root, "Local State"))
	if os.IsNotExist(err) {
		return []ChromeProfile{}, nil
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
	out := []ChromeProfile{}
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
		out = append(out, ChromeProfile{Directory: directory, Name: name})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// OpenSettings uses Chrome's last active existing profile and tells the window
// which profile it belongs to, so same-profile connections reuse that window.
func (p *ChromeProfiles) OpenSettings(preferred ...string) error {
	if len(preferred) > 0 && preferred[0] != "" {
		profiles, err := p.List()
		if err != nil {
			return err
		}
		for _, profile := range profiles {
			if profile.Directory == preferred[0] {
				return p.launch(profile.Directory, DesktopOrigin+"/settings?chrome-profile="+url.QueryEscape(profile.Directory), true)
			}
		}
		return errors.New("Chrome profile no longer exists")
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
	return p.launch(profile, DesktopOrigin+"/settings?chrome-profile="+url.QueryEscape(profile), true)
}

func validProfileDirectory(name string) bool {
	return name != "" && name != "." && name != ".." && filepath.Base(name) == name && !strings.ContainsAny(name, "/\\\x00")
}

func profileForAuth(auth *clientcmdapi.AuthInfo) (ChromeProfile, error) {
	if auth == nil {
		return ChromeProfile{}, nil
	}
	var preferences desktopPreferences
	if extension := auth.Extensions[desktopExtension]; extension != nil {
		body, err := json.Marshal(extension)
		if err != nil {
			return ChromeProfile{}, err
		}
		if err = json.Unmarshal(body, &preferences); err != nil {
			return ChromeProfile{}, fmt.Errorf("invalid %s extension: %w", desktopExtension, err)
		}
	}
	if preferences.ChromeProfile != nil {
		return *preferences.ChromeProfile, nil
	}
	// Read unambiguous legacy associations without keeping API-scoped semantics.
	var selected ChromeProfile
	for _, profile := range preferences.ChromeProfiles {
		if selected.Directory != "" && selected.Directory != profile.Directory {
			return ChromeProfile{}, nil
		}
		selected = profile
	}
	return selected, nil
}

func (p *ChromeProfiles) Set(discovery *ContextDiscovery, key, directory string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	var selected ChromeProfile
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
			return errors.New("Chrome profile no longer exists")
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
	for _, g := range contextGroups(resolved) {
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
		// Preserve other extension fields, including fields written by a future
		// Driftmower version, and every unrelated kubeconfig setting.
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
		delete(extension, "chromeProfiles")
		if directory == "" {
			delete(extension, "chromeProfile")
		} else {
			body, err := json.Marshal(selected)
			if err != nil {
				return err
			}
			extension["chromeProfile"] = body
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
				discovery.contexts[i].ChromeProfile = nil
			} else {
				copy := selected
				discovery.contexts[i].ChromeProfile = &copy
			}
			discovery.contexts[i].Status = "checking"
		}
	}
	discovery.mu.Unlock()
	if discovery.forwards != nil {
		discovery.forwards.drop(forwardIdentityKey(key, group.ChromeProfile))
	}
	select {
	case discovery.wake <- struct{}{}:
	default:
	}
	return nil
}

// Only the explicit desktop login clones get these overrides. The source
// kubeconfig and kubectl's own cache/browser settings are left untouched.
func (p *ChromeProfiles) prepare(auth *clientcmdapi.AuthInfo, server, key string) error {
	profile, err := profileForAuth(auth)
	if err != nil {
		return err
	}
	if profile.Directory == "" || auth == nil || auth.Exec == nil {
		return nil
	}
	if !validProfileDirectory(profile.Directory) {
		return errors.New("invalid Chrome profile directory")
	}
	if info, err := os.Stat(filepath.Join(p.root, profile.Directory)); err != nil || !info.IsDir() {
		return errors.New("assigned Chrome profile no longer exists")
	}
	if usesOIDCLogin(auth) {
		sum := sha256.Sum256([]byte(key + "\x00" + p.root + "\x00" + profile.Directory))
		cache := filepath.Join(p.cache, hex.EncodeToString(sum[:]))
		auth.Exec.Args = setExecFlag(auth.Exec.Args, "token-cache-dir", cache)
		auth.Exec.Args = setExecFlag(auth.Exec.Args, "token-cache-storage", "")
		auth.Exec.Args = setExecFlag(auth.Exec.Args, "browser-command", p.helper)
	}
	// AWS/Azure CLI browser launchers also honor BROWSER where supported.
	for name, value := range map[string]string{"BROWSER": p.helper, "DRIFTMOWER_OPEN_AUTH_URL": "1", "DRIFTMOWER_CHROME_BINARY": p.browser, "DRIFTMOWER_CHROME_ROOT": p.root, "DRIFTMOWER_CHROME_PROFILE": profile.Directory} {
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

func OpenChromeProfile(browser, root, profile, target string, app bool) error {
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
	if !validProfileDirectory(profile) {
		return errors.New("invalid Chrome profile directory")
	}
	args := []string{"--user-data-dir=" + root, "--profile-directory=" + profile, "--new-window"}
	if app {
		args = append(args, "--app="+target)
	} else {
		args = append(args, target)
	}
	cmd := exec.Command(browser, args...)
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
