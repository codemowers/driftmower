package dashboard

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

func TestCloudPluginRecognisesSilentAWSAndAzure(t *testing.T) {
	for _, tc := range []struct {
		command string
		args    []string
		want    cloudKind
		ok      bool
	}{
		{"aws", []string{"--region", "us-west-2", "eks", "get-token", "--cluster-name", "c"}, cloudAWS, true},
		{"/usr/bin/kubelogin", []string{"get-token", "--login", "azurecli", "--server-id", "x"}, cloudAzure, true},
		{"kubelogin", []string{"get-token", "--login=devicecode"}, cloudAzure, false},
		{"kubelogin", []string{"get-token", "--oidc-issuer-url", "https://auth.example.com/"}, "", false},
		{"gke-gcloud-auth-plugin", nil, "", false},
	} {
		kind, ok := cloudPlugin(&clientcmdapi.ExecConfig{Command: tc.command, Args: tc.args})
		if ok != tc.ok || (ok && kind != tc.want) {
			t.Errorf("%s %v = %q %v", tc.command, tc.args, kind, ok)
		}
	}
}

func TestAzureLoginTargetsThePluginsTenantAndScope(t *testing.T) {
	name, args, ok := cloudLoginCommand(&clientcmdapi.AuthInfo{Exec: &clientcmdapi.ExecConfig{Command: "kubelogin",
		Args: []string{"get-token", "--login", "azurecli", "--server-id", "server", "--tenant-id", "tenant"}}})
	if !ok || name != "az" || !slices.Equal(args, []string{"login", "--tenant", "tenant", "--scope", "server/.default"}) {
		t.Fatalf("%s %v %v", name, args, ok)
	}
}

func TestAWSLoginFollowsTheProfile(t *testing.T) {
	config := filepath.Join(t.TempDir(), "config")
	if err := os.WriteFile(config, []byte("[default]\nlogin_session = arn:aws:iam::1:root\n[profile dev]\nsso_session = corp\n[profile keys]\nregion = eu-north-1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AWS_CONFIG_FILE", config)
	t.Setenv("AWS_PROFILE", "")
	aws := func(args ...string) *clientcmdapi.AuthInfo {
		return &clientcmdapi.AuthInfo{Exec: &clientcmdapi.ExecConfig{Command: "aws", Args: append([]string{"eks", "get-token"}, args...)}}
	}
	if _, args, ok := cloudLoginCommand(aws()); !ok || !slices.Equal(args, []string{"login"}) {
		t.Fatalf("default: %v %v", args, ok)
	}
	if _, args, ok := cloudLoginCommand(aws("--profile", "dev")); !ok || !slices.Equal(args, []string{"sso", "login", "--profile", "dev"}) {
		t.Fatalf("sso: %v %v", args, ok)
	}
	if _, _, ok := cloudLoginCommand(aws("--profile", "keys")); ok {
		t.Fatal("static keys offered a sign-in")
	}
}

// plugin writes an executable script standing in for a credential plugin.
func plugin(t *testing.T, body string) string {
	path := filepath.Join(t.TempDir(), "kubelogin")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCloudCredentialsRunThePluginOnceAndKeepItsToken(t *testing.T) {
	counter := filepath.Join(t.TempDir(), "runs")
	command := plugin(t, "echo run >> "+counter+"\n"+
		`echo '{"kind":"ExecCredential","status":{"token":"minted","expirationTimestamp":"2099-01-01T00:00:00Z"}}'`+"\n")
	for range 2 {
		auth := &clientcmdapi.AuthInfo{Exec: &clientcmdapi.ExecConfig{Command: command, Args: []string{"get-token", "--login", "azurecli", "--server-id", "s"}}}
		if err := StaticCredentials(auth, time.Now(), nil); err != nil {
			t.Fatal(err)
		}
		if auth.Exec != nil || auth.Token != "minted" {
			t.Fatalf("%+v", auth)
		}
	}
	runs, _ := os.ReadFile(counter)
	if strings.Count(string(runs), "run") != 1 {
		t.Fatalf("plugin ran %q", runs)
	}
}

func TestCloudCredentialsReportThePluginsExplanation(t *testing.T) {
	command := plugin(t, "echo 'Error: failed to get token: AzureCLICredential: ERROR: AADSTS50078: Presented multi-factor authentication has expired. Trace ID: abc Correlation ID: def' >&2\n"+
		"echo 'Run the command below to authenticate interactively; additional arguments may be added as needed:' >&2\n"+
		"echo 'az logout' >&2\nexit 1\n")
	auth := &clientcmdapi.AuthInfo{Exec: &clientcmdapi.ExecConfig{Command: command, Args: []string{"get-token", "--login", "azurecli", "--server-id", "other"}}}
	err := StaticCredentials(auth, time.Now(), nil)
	session, ok := err.(*ErrCloudSession)
	if !ok || session.Message != "AADSTS50078: Presented multi-factor authentication has expired." {
		t.Fatalf("%v", err)
	}
}
