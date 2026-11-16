package dashboard

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

// Cloud credential plugins mint a token from the person's cloud CLI session
// without prompting, so discovery may run them: AWS `aws eks get-token`, and
// Azure kubelogin in a mode that needs no browser. The dashboard runs them
// itself and keeps their tokens until they expire. When the session has
// expired they fail, and signing in runs the CLI's own login.
type cloudKind string

const (
	cloudAWS   cloudKind = "AWS"
	cloudAzure cloudKind = "Azure"
)

// Azure kubelogin modes that read an existing session rather than prompt.
var azureSilentModes = map[string]bool{"azurecli": true, "azd": true, "msi": true, "workloadidentity": true, "spn": true}

func cloudPlugin(plugin *clientcmdapi.ExecConfig) (cloudKind, bool) {
	if plugin == nil || len(plugin.Args) == 0 {
		return "", false
	}
	args := plugin.Args
	switch path.Base(plugin.Command) {
	case "aws":
		for i := 0; i+1 < len(args); i++ {
			if args[i] == "eks" && args[i+1] == "get-token" {
				return cloudAWS, true
			}
		}
	case "kubelogin":
		if args[0] != "get-token" {
			return "", false
		}
		for i, a := range args {
			if mode, ok := strings.CutPrefix(a, "--login="); ok {
				return cloudAzure, azureSilentModes[mode]
			}
			if (a == "--login" || a == "-l") && i+1 < len(args) {
				return cloudAzure, azureSilentModes[args[i+1]]
			}
		}
	}
	return "", false
}

// cloudTokens holds tokens the plugins minted, by plugin invocation, until
// shortly before they expire, so discovery does not run a plugin every minute.
var cloudTokens sync.Map // cloudKey -> cloudToken

type cloudToken struct {
	token   string
	expires time.Time
}

func cloudKey(plugin *clientcmdapi.ExecConfig) string {
	key := plugin.Command + "\x00" + strings.Join(plugin.Args, "\x00")
	for _, e := range plugin.Env {
		key += "\x00" + e.Name + "=" + e.Value
	}
	return key
}

// forgetCloudToken drops a cached token, after a sign-in renewed the session.
func forgetCloudToken(auth *clientcmdapi.AuthInfo) {
	if auth != nil && auth.Exec != nil {
		cloudTokens.Delete(cloudKey(auth.Exec))
	}
}

// ErrCloudSession is a cloud CLI session that has expired or is missing;
// its message is the plugin's own explanation.
type ErrCloudSession struct{ Message string }

func (e *ErrCloudSession) Error() string { return e.Message }

// cloudCredentials runs an AWS or Azure plugin itself, rather than letting
// client-go run it, so its error reaches the dashboard instead of the
// terminal, and replaces the plugin with the token it minted.
func cloudCredentials(auth *clientcmdapi.AuthInfo, now time.Time) error {
	plugin := auth.Exec
	key := cloudKey(plugin)
	if cached, ok := cloudTokens.Load(key); ok && cached.(cloudToken).expires.After(now.Add(time.Minute)) {
		auth.Exec, auth.Token = nil, cached.(cloudToken).token
		return nil
	}
	command, err := resolveCommand(plugin.Command, auth.LocationOfOrigin)
	if err != nil {
		return err
	}
	info, _ := json.Marshal(map[string]any{"apiVersion": plugin.APIVersion, "kind": "ExecCredential", "spec": map[string]any{"interactive": false}})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, command, plugin.Args...)
	cmd.Env = append(os.Environ(), "PATH="+pluginPath(), "KUBERNETES_EXEC_INFO="+string(info))
	for _, e := range plugin.Env {
		cmd.Env = append(cmd.Env, e.Name+"="+e.Value)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if msg := pluginError(stderr.String()); msg != "" {
			return &ErrCloudSession{Message: msg}
		}
		return fmt.Errorf("%s: %w", path.Base(command), err)
	}
	var credential struct {
		Status struct {
			Token               string    `json:"token"`
			ExpirationTimestamp time.Time `json:"expirationTimestamp"`
		} `json:"status"`
	}
	if json.Unmarshal(stdout.Bytes(), &credential) != nil || credential.Status.Token == "" {
		return fmt.Errorf("%s returned no token", path.Base(command))
	}
	expires := credential.Status.ExpirationTimestamp
	if expires.IsZero() {
		expires = now.Add(10 * time.Minute)
	}
	cloudTokens.Store(key, cloudToken{token: credential.Status.Token, expires: expires})
	auth.Exec, auth.Token = nil, credential.Status.Token
	return nil
}

var (
	pluginErrorPrefix = regexp.MustCompile(`^(Error: )?(failed to get token: )?(AzureCLICredential: )?(ERROR: )?(aws: \[ERROR\]: )?`)
	aadTrailer        = regexp.MustCompile(`\s*Trace ID:.*$`)
)

// pluginError reduces a plugin's stderr to the sentence that explains it,
// leaving out trace IDs and the suggested commands Sign in runs anyway.
func pluginError(stderr string) string {
	for _, line := range strings.Split(stderr, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "Run the command") || strings.HasPrefix(line, "az ") {
			continue
		}
		line = aadTrailer.ReplaceAllString(pluginErrorPrefix.ReplaceAllString(line, ""), "")
		if line != "" {
			return line
		}
	}
	return ""
}

func resolveCommand(command, kubeconfig string) (string, error) {
	switch {
	case filepath.IsAbs(command):
		return command, nil
	case strings.ContainsRune(command, filepath.Separator):
		// client-go resolves relative commands against the kubeconfig's directory.
		return filepath.Join(filepath.Dir(kubeconfig), command), nil
	}
	found, err := lookPath(command, pluginPath())
	if err != nil {
		return "", fmt.Errorf("%s not found", command)
	}
	return found, nil
}

func flagValue(args []string, names ...string) string {
	for i, a := range args {
		for _, name := range names {
			if v, ok := strings.CutPrefix(a, name+"="); ok {
				return v
			}
			if a == name && i+1 < len(args) {
				return args[i+1]
			}
		}
	}
	return ""
}

// cloudLoginCommand is the CLI login that renews a plugin's session. Azure:
// `az login` for the plugin's tenant and the cluster's scope, which also
// refreshes multi-factor authentication. AWS: `aws login` for a profile with
// a login_session, `aws sso login` for an SSO profile; a profile with static
// keys has nothing to sign in to.
func cloudLoginCommand(auth *clientcmdapi.AuthInfo) (string, []string, bool) {
	if auth == nil {
		return "", nil, false
	}
	kind, ok := cloudPlugin(auth.Exec)
	if !ok {
		return "", nil, false
	}
	args := auth.Exec.Args
	if kind == cloudAzure {
		login := []string{"login"}
		if tenant := flagValue(args, "--tenant-id", "-t"); tenant != "" {
			login = append(login, "--tenant", tenant)
		}
		if server := flagValue(args, "--server-id"); server != "" {
			login = append(login, "--scope", server+"/.default")
		}
		return "az", login, true
	}
	profile := flagValue(args, "--profile")
	for _, e := range auth.Exec.Env {
		if e.Name == "AWS_PROFILE" && profile == "" {
			profile = e.Value
		}
	}
	if profile == "" {
		profile = os.Getenv("AWS_PROFILE")
	}
	var login []string
	switch awsProfileKind(profile) {
	case "login":
		login = []string{"login"}
	case "sso":
		login = []string{"sso", "login"}
	default:
		return "", nil, false
	}
	if profile != "" {
		login = append(login, "--profile", profile)
	}
	return "aws", login, true
}

// awsProfileKind reads ~/.aws/config: "login" for a login_session profile,
// "sso" for an SSO one, otherwise "".
func awsProfileKind(profile string) string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	file := filepath.Join(home, ".aws", "config")
	if v := os.Getenv("AWS_CONFIG_FILE"); v != "" {
		file = v
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return ""
	}
	section := "default"
	if profile != "" && profile != "default" {
		section = "profile " + profile
	}
	current, kind := "", ""
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			current = strings.TrimSpace(line[1 : len(line)-1])
			continue
		}
		if current != section {
			continue
		}
		key, _, _ := strings.Cut(line, "=")
		switch strings.TrimSpace(key) {
		case "login_session":
			kind = "login"
		case "sso_session", "sso_start_url":
			if kind == "" {
				kind = "sso"
			}
		}
	}
	return kind
}

// runCloudLogin runs the CLI login, which opens the browser, with the
// plugin's environment, so AZURE_CONFIG_DIR and AWS_PROFILE carry over.
func runCloudLogin(ctx context.Context, auth *clientcmdapi.AuthInfo) error {
	name, args, ok := cloudLoginCommand(auth)
	if !ok {
		return errors.New("this context's cloud credentials have no sign-in")
	}
	command, err := resolveCommand(name, "")
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, signInTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Env = append(os.Environ(), "PATH="+pluginPath())
	for _, e := range auth.Exec.Env {
		cmd.Env = append(cmd.Env, e.Name+"="+e.Value)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return errors.New("sign-in was not completed in the browser in time")
		}
		if msg := pluginError(stderr.String()); msg != "" {
			return fmt.Errorf("%s: %s", name, msg)
		}
		return fmt.Errorf("%s: %w", name, err)
	}
	forgetCloudToken(auth)
	return nil
}
