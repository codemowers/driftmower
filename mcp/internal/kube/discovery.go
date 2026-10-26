package kube

import (
	"errors"
	"strings"

	"k8s.io/client-go/discovery"
)

// ServedResource is one kind the API server serves at one version.
type ServedResource struct {
	Group      string
	Version    string
	Kind       string
	Plural     string
	Namespaced bool
}

// APISurface is what the cluster's API serves.
type APISurface struct {
	// KindKey(group, version, kind) -> the resource.
	ByKind map[string]ServedResource
	// Group -> served versions, in the order the API server reported them.
	VersionsByGroup map[string][]string
}

func KindKey(group, version, kind string) string {
	if group == "" {
		return version + "/" + kind
	}

	return group + "/" + version + "/" + kind
}

// LoadAPISurface reads discovery for the core and every named group.
// client-go uses aggregated discovery where the server supports it and falls
// back to one request per group version otherwise. A group version that fails
// to list (it can vanish between calls) keeps its version entry but
// contributes no kinds.
//
// Discovery needs no RBAC of its own: system:discovery grants it to every
// authenticated principal.
func LoadAPISurface(d discovery.DiscoveryInterface) (*APISurface, error) {
	groups, lists, err := d.ServerGroupsAndResources()
	var partial *discovery.ErrGroupDiscoveryFailed
	if err != nil && !errors.As(err, &partial) {
		return nil, err
	}

	surface := &APISurface{ByKind: map[string]ServedResource{}, VersionsByGroup: map[string][]string{}}
	for _, g := range groups {
		for _, v := range g.Versions {
			surface.VersionsByGroup[g.Name] = append(surface.VersionsByGroup[g.Name], v.Version)
		}
	}
	for _, list := range lists {
		group, version, _ := strings.Cut(list.GroupVersion, "/")
		if version == "" {
			group, version = "", group
		}
		for _, r := range list.APIResources {
			// Subresources such as "podmonitors/status" are never creatable on
			// their own and would only pollute the lookup.
			if r.Name == "" || r.Kind == "" || strings.Contains(r.Name, "/") {
				continue
			}
			surface.ByKind[KindKey(group, version, r.Kind)] = ServedResource{
				Group:      group,
				Version:    version,
				Kind:       r.Kind,
				Plural:     r.Name,
				Namespaced: r.Namespaced,
			}
		}
	}

	return surface, nil
}

// NegotiateVersion picks the first supported version the cluster serves for a
// kind, or reports false when it serves none of them.
func (s *APISurface) NegotiateVersion(group, kind string, supported []string) (ServedResource, bool) {
	for _, version := range supported {
		if r, ok := s.ByKind[KindKey(group, version, kind)]; ok {
			return r, true
		}
	}

	return ServedResource{}, false
}

func (s *APISurface) ServesGroup(group string) bool {
	_, ok := s.VersionsByGroup[group]

	return ok
}
