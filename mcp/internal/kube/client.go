// Package kube builds the Kubernetes clients this server uses with its own
// ServiceAccount credentials, and the shared helpers on top of them.
package kube

import (
	"fmt"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/metadata"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"

	"github.com/codemowers/driftmower-mcp/internal/config"
)

// Clients holds the server's Kubernetes clients.
type Clients struct {
	// Kubernetes bounds every request by the configured timeout.
	Kubernetes kubernetes.Interface
	// Dynamic reads optional and custom resources, bounded like Kubernetes.
	Dynamic dynamic.Interface
	// Metadata has no overall timeout, because informers hold long-lived
	// watches on it.
	Metadata metadata.Interface
}

// RESTConfig returns the base configuration for the API server, without a
// request timeout. client-go rereads the token file periodically, which
// follows projected-token rotation; the CA file is read once.
func RESTConfig(c config.Kubernetes) *rest.Config {
	return &rest.Config{
		Host:            c.URL,
		BearerTokenFile: c.TokenFile,
		TLSClientConfig: rest.TLSClientConfig{CAFile: c.CAFile},
		UserAgent:       "driftmower-mcp",
		// Access sweeps fan out to many SubjectAccessReviews at once; the
		// client-side default of 5 QPS would serialise them.
		QPS:   200,
		Burst: 400,
	}
}

func NewClients(c config.Kubernetes) (*Clients, error) {
	base := RESTConfig(c)
	if c.Kubeconfig != "" {
		loaded, err := clientcmd.BuildConfigFromFlags("", c.Kubeconfig)
		if err != nil {
			return nil, fmt.Errorf("load kubeconfig: %w", err)
		}
		loaded.UserAgent, loaded.QPS, loaded.Burst = base.UserAgent, base.QPS, base.Burst
		base = loaded
	}

	bounded := rest.CopyConfig(base)
	bounded.Timeout = c.RequestTimeout
	k, err := kubernetes.NewForConfig(bounded)
	if err != nil {
		return nil, fmt.Errorf("kubernetes client: %w", err)
	}
	d, err := dynamic.NewForConfig(bounded)
	if err != nil {
		return nil, fmt.Errorf("kubernetes dynamic client: %w", err)
	}
	m, err := metadata.NewForConfig(base)
	if err != nil {
		return nil, fmt.Errorf("kubernetes metadata client: %w", err)
	}

	return &Clients{Kubernetes: k, Dynamic: d, Metadata: m}, nil
}
