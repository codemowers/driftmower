package dashboard

import (
	"flag"
	"io/fs"
	"os"
	"strings"
)

const (
	DesktopPort    = "17843"
	DesktopAddress = "127.0.0.1:" + DesktopPort
	DesktopOrigin  = "http://localhost:" + DesktopPort
)

// Config holds the configuration for both the web server and the desktop app.
type Config struct {
	Status             bool
	PID                bool
	Stop               bool
	Restart            bool
	FlagError          error
	InstallDesktop     bool
	ChromeProfile      string
	ChromeProfiles     *ChromeProfiles
	DiscoverKubeconfig bool
	Kubeconfig         string
	AssetFS            fs.FS
	AssetDir           string
	ListenAddr         string
	KubeContext        string
	McpURL             string
	McpEndpoints       string
	// Lets people run kubelogin from Settings. Only the desktop application
	// sets it: it runs as the person, on their machine.
	KubeLogin bool
}

func LoadConfig(args []string) *Config {
	cfg := &Config{}

	fs := flag.NewFlagSet("dashboard", flag.ContinueOnError)
	fs.BoolVar(&cfg.InstallDesktop, "install-desktop", false, "Install the Linux application launcher and icon, then exit")
	fs.StringVar(&cfg.ChromeProfile, "chrome-profile", "", "Open the desktop window in this existing Chrome profile directory")
	fs.BoolVar(&cfg.DiscoverKubeconfig, "discover-kubeconfig", false, "Discover MCP installations using local kubeconfig contexts")
	fs.StringVar(&cfg.Kubeconfig, "kubeconfig", "", "Kubeconfig file (defaults to KUBECONFIG or ~/.kube/config)")

	fs.BoolVar(&cfg.Status, "status", false, "Show the running desktop PID and URL, then exit")
	fs.BoolVar(&cfg.PID, "pid", false, "Print the running desktop PID, then exit")
	fs.BoolVar(&cfg.Stop, "stop", false, "Stop the running desktop, then exit")
	fs.BoolVar(&cfg.Restart, "restart", false, "Stop the running desktop and start this executable")
	cfg.FlagError = fs.Parse(args)

	cfg.AssetDir = os.Getenv("ASSET_DIR")
	if cfg.AssetDir == "" {
		cfg.AssetDir = "/app/public"
	}

	cfg.ListenAddr = os.Getenv("LISTEN_ADDR")
	if cfg.ListenAddr == "" {
		cfg.ListenAddr = "[::]:8080"
	}

	cfg.McpURL = os.Getenv("MCP_URL")
	if cfg.McpURL != "" {
		cfg.McpURL = strings.TrimRight(cfg.McpURL, "/")
		if !strings.HasSuffix(cfg.McpURL, "/mcp") {
			cfg.McpURL += "/mcp"
		}
	}

	cfg.KubeContext = os.Getenv("KUBECTL_CONTEXT")
	cfg.McpEndpoints = os.Getenv("MCP_ENDPOINTS")

	return cfg
}
