package provisioning

import (
	"regexp"
	"slices"
	"strings"
)

// A container registry a namespace can push to, found in the namespace itself
// rather than assumed from any platform convention: a Deployment that runs
// Zot, a Service that selects its pods, and an Ingress that publishes that
// Service under a hostname.

type RegistryDeployment struct {
	Name      string
	PodLabels map[string]string
	Images    []string
}

type RegistryService struct {
	Name     string
	Selector map[string]string
}

type IngressRuleInput struct {
	Host     string
	Services []string
}

type RegistryIngress struct {
	Name     string
	TLSHosts []string
	Rules    []IngressRuleInput
}

type RegistryFact struct {
	Kind string `json:"kind"`
	Host string `json:"host"`
	// Whether the Ingress terminates TLS for this host. Without it the
	// registry is plain HTTP, which Docker and Skaffold refuse unless told.
	TLS        bool   `json:"tls"`
	Deployment string `json:"deployment"`
	Service    string `json:"service"`
	Ingress    string `json:"ingress"`
	// A ready-to-save skaffold.env for this namespace and registry.
	SkaffoldEnv string `json:"skaffoldEnv"`
}

var zotRepository = regexp.MustCompile(`^zot(?:-[a-z0-9-]+)?$`)

// IsZotImage matches zot, zot-minimal and per-arch builds, wherever mirrored.
func IsZotImage(image string) bool {
	image, _, _ = strings.Cut(image, "@")
	segment := image[strings.LastIndex(image, "/")+1:]
	repository, _, _ := strings.Cut(segment, ":")

	return zotRepository.MatchString(repository)
}

// FindRegistries returns registries without their skaffold.env.
func FindRegistries(deployments []RegistryDeployment, services []RegistryService, ingresses []RegistryIngress) []RegistryFact {
	found := []RegistryFact{}
	for _, d := range deployments {
		if !slices.ContainsFunc(d.Images, IsZotImage) {
			continue
		}
		for _, s := range services {
			// A Service without a selector routes to nothing on its own.
			if s.Name == "" || len(s.Selector) == 0 {
				continue
			}
			selects := true
			for k, v := range s.Selector {
				if d.PodLabels[k] != v {
					selects = false
				}
			}
			if !selects {
				continue
			}
			for _, ing := range ingresses {
				for _, rule := range ing.Rules {
					if rule.Host == "" || !slices.Contains(rule.Services, s.Name) ||
						slices.ContainsFunc(found, func(f RegistryFact) bool { return f.Host == rule.Host }) {
						continue
					}
					found = append(found, RegistryFact{
						Kind:       "zot",
						Host:       rule.Host,
						TLS:        slices.Contains(ing.TLSHosts, rule.Host),
						Deployment: orUnnamed(d.Name),
						Service:    s.Name,
						Ingress:    orUnnamed(ing.Name),
					})
				}
			}
		}
	}
	slices.SortStableFunc(found, func(a, b RegistryFact) int { return localeCompare(a.Host, b.Host) })

	return found
}

func orUnnamed(name string) string {
	if name == "" {
		return "(unnamed)"
	}

	return name
}

// SkaffoldEnvFor targets the namespace-qualified context the connection
// instructions ask for, so a build is pushed here and deployed to this
// namespace, never to whatever context happens to be current.
func SkaffoldEnvFor(context, registryHost, namespace string) string {
	return strings.Join([]string{
		"SKAFFOLD_KUBE_CONTEXT=" + context,
		"SKAFFOLD_DEFAULT_REPO=" + registryHost,
		"SKAFFOLD_NAMESPACE=" + namespace,
		// Keep the deployment running after `skaffold dev` exits.
		"SKAFFOLD_CLEANUP=false",
	}, "\n")
}

func KubeContextFor(clusterID *string, namespace string) string {
	id := "<cluster>"
	if clusterID != nil {
		id = *clusterID
	}

	return id + "/" + namespace
}
