package dashboard

import "testing"

func TestHostedKubectlContextIsPublicRuntimeConfiguration(t *testing.T) {
	t.Setenv("KUBECTL_CONTEXT", "admin@cluster.example.com")
	cfg := LoadConfig(nil)
	if cfg.KubeContext != "admin@cluster.example.com" {
		t.Fatalf("context %q", cfg.KubeContext)
	}
	d := New(cfg)
	if d.GetConfig().KubeContext != cfg.KubeContext {
		t.Fatal("command context missing from dashboard configuration")
	}
}

func TestDesktopProcessFlags(t *testing.T) {
	for _, arg := range []string{"--status", "--pid", "--stop", "--restart"} {
		cfg := LoadConfig([]string{arg})
		if cfg.FlagError != nil || !(cfg.Status || cfg.PID || cfg.Stop || cfg.Restart) {
			t.Fatalf("%s: %v", arg, cfg.FlagError)
		}
	}
	if cfg := LoadConfig([]string{"--unknown-option"}); cfg.FlagError == nil {
		t.Fatal("unknown option ignored")
	}
}
