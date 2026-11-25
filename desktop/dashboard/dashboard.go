package dashboard

import (
	"encoding/json"
	"sync"
	"sync/atomic"
)

type DashboardConfigResponse struct {
	ConfigUpdates          bool                `json:"configUpdates,omitempty"`
	DiscoveryError         string              `json:"discoveryError,omitempty"`
	BrowserProfiles        []BrowserProfile    `json:"browserProfiles,omitempty"`
	Browser                Browser             `json:"browser,omitempty"`
	BrowserProfilesEnabled bool                `json:"browserProfilesEnabled,omitempty"`
	BrowserProfilesError   string              `json:"browserProfilesError,omitempty"`
	KubeContext            string              `json:"kubeContext,omitempty"`
	McpURL                 string              `json:"mcpUrl"`
	Clusters               []ClusterEndpoint   `json:"clusters"`
	Contexts               []DiscoveredContext `json:"contexts"`
	DiscoveryEnabled       bool                `json:"discoveryEnabled"`
}

type Dashboard struct {
	cfg       *Config
	discovery *ContextDiscovery
	clusters  []ClusterEndpoint
	mu        sync.RWMutex
	lastSeen  atomic.Int64
}

// Close releases discovery and desktop-owned port-forward listeners.
func (d *Dashboard) Close() { d.discovery.Close() }

func New(cfg *Config) *Dashboard {
	d := &Dashboard{
		cfg: cfg,
	}

	if cfg.McpEndpoints != "" {
		_ = json.Unmarshal([]byte(cfg.McpEndpoints), &d.clusters)
	}
	d.discovery = StartDiscovery(cfg.DiscoverKubeconfig, cfg.Kubeconfig, cfg.KubeLogin, cfg.BrowserProfiles)

	return d
}

func (d *Dashboard) GetConfig() DashboardConfigResponse {
	d.mu.RLock()
	defer d.mu.RUnlock()

	contexts, availableClusters := d.discovery.Snapshot()

	allClusters := append([]ClusterEndpoint{}, d.clusters...)
	allClusters = append(allClusters, availableClusters...)

	result := DashboardConfigResponse{
		ConfigUpdates:    d.cfg.KubeLogin,
		DiscoveryError:   d.discovery.watchError(),
		KubeContext:      d.cfg.KubeContext,
		McpURL:           d.cfg.McpURL,
		Clusters:         allClusters,
		Contexts:         contexts,
		DiscoveryEnabled: d.cfg.DiscoverKubeconfig,
	}
	if d.cfg.BrowserProfiles != nil {
		result.BrowserProfilesEnabled = true
		result.Browser = d.cfg.BrowserProfiles.Kind()
		var err error
		result.BrowserProfiles, err = d.cfg.BrowserProfiles.List()
		if err != nil {
			result.BrowserProfilesError = err.Error()
		}
	}
	return result
}

func (d *Dashboard) GetConfigJSON() ([]byte, error) {
	return json.Marshal(d.GetConfig())
}
