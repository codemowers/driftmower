package dashboard

import (
	"encoding/json"
	"sync"
	"sync/atomic"
)

// DashboardConfigResponse is the JSON payload sent to the frontend.
type DashboardConfigResponse struct {
	ChromeProfiles        []ChromeProfile     `json:"chromeProfiles,omitempty"`
	ChromeProfilesEnabled bool                `json:"chromeProfilesEnabled,omitempty"`
	ChromeProfilesError   string              `json:"chromeProfilesError,omitempty"`
	KubeContext           string              `json:"kubeContext,omitempty"`
	McpURL                string              `json:"mcpUrl"`
	Clusters              []ClusterEndpoint   `json:"clusters"`
	Contexts              []DiscoveredContext `json:"contexts"`
	DiscoveryEnabled      bool                `json:"discoveryEnabled"`
}

// Dashboard manages the state of the dashboard, including discovery and configuration.
type Dashboard struct {
	cfg       *Config
	discovery *ContextDiscovery
	clusters  []ClusterEndpoint
	mu        sync.RWMutex
	lastSeen  atomic.Int64
}

// Close releases discovery and desktop-owned port-forward listeners.
func (d *Dashboard) Close() { d.discovery.Close() }

// New creates a new Dashboard instance.
func New(cfg *Config) *Dashboard {
	d := &Dashboard{
		cfg: cfg,
	}

	// Parse clusters from MCP_ENDPOINTS env var
	if cfg.McpEndpoints != "" {
		if err := json.Unmarshal([]byte(cfg.McpEndpoints), &d.clusters); err != nil {
			// In a real app, we might want to log this or handle it better.
			// For now, we'll just have an empty cluster list.
		}
	}

	// Start discovery if enabled
	// We pass the kubeconfig path (either from flag or default)
	kubeconfigPath := cfg.Kubeconfig
	if kubeconfigPath == "" {
		// In a real app, we might want to resolve the default path here.
		// But we'll let StartDiscovery handle it if we pass an empty string.
	}
	d.discovery = StartDiscovery(cfg.DiscoverKubeconfig, kubeconfigPath, cfg.KubeLogin, cfg.ChromeProfiles)

	return d
}

// GetConfig returns the current dashboard configuration for the frontend.
func (d *Dashboard) GetConfig() DashboardConfigResponse {
	d.mu.RLock()
	defer d.mu.RUnlock()

	contexts, availableClusters := d.discovery.Snapshot()

	// Merge manually provided clusters with discovered ones
	// (In the current implementation, they are appended)
	allClusters := append([]ClusterEndpoint{}, d.clusters...)
	allClusters = append(allClusters, availableClusters...)

	result := DashboardConfigResponse{
		KubeContext:      d.cfg.KubeContext,
		McpURL:           d.cfg.McpURL,
		Clusters:         allClusters,
		Contexts:         contexts,
		DiscoveryEnabled: d.cfg.DiscoverKubeconfig,
	}
	if d.cfg.ChromeProfiles != nil {
		result.ChromeProfilesEnabled = true
		var err error
		result.ChromeProfiles, err = d.cfg.ChromeProfiles.List()
		if err != nil {
			result.ChromeProfilesError = err.Error()
		}
	}
	return result
}

// GetConfigJSON returns the configuration as a JSON byte slice.
func (d *Dashboard) GetConfigJSON() ([]byte, error) {
	return json.Marshal(d.GetConfig())
}
