// Package platformapis discovers optional cluster integrations at startup.
package platformapis

import (
	"fmt"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/client-go/discovery"
)

const NodestatdInstall = "helm install nodestatd oci://ghcr.io/codemowers/charts/nodestatd --namespace kube-system"

// HasResources checks served APIs rather than requiring permission to read CRDs.
// Discovery failures are errors, never evidence that a component is absent.
func HasResources(d discovery.DiscoveryInterface, groupVersion string, names ...string) (bool, error) {
	resources, err := d.ServerResourcesForGroupVersion(groupVersion)
	if apierrors.IsNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("discover %s: %w", groupVersion, err)
	}
	for _, name := range names {
		found := false
		for _, resource := range resources.APIResources {
			if resource.Name == name {
				found = true
				break
			}
		}
		if !found {
			return false, nil
		}
	}
	return true, nil
}
