// Package workloads resolves the live objects of a namespace into root
// workloads with their pods, images and namespace-local dependencies.
package workloads

import (
	"slices"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Category names a dependency collection of a workload.
type Category string

const (
	Pods         Category = "pods"
	Images       Category = "images"
	ConfigMaps   Category = "configmaps"
	Secrets      Category = "secrets"
	PVCs         Category = "pvcs"
	Services     Category = "services"
	Ingresses    Category = "ingresses"
	Certificates Category = "certificates"
)

var categories = []Category{Pods, Images, ConfigMaps, Secrets, PVCs, Services, Ingresses, Certificates}

// Source is a kind the inventory lists. Sources with a category are
// dependencies; the others are workload controllers or fixed custom roots.
type Source struct {
	APIVersion   string
	Kind         string
	Resource     string
	Category     Category
	MetadataOnly bool
}

// Group returns the API group of the source.
func (s *Source) Group() string { return group(s.APIVersion) }

// Sources are always listed. Other custom owner kinds are terminal labels
// from ownerReferences and are never listed for ancestry resolution.
var Sources = []*Source{
	{APIVersion: "v1", Kind: "Pod", Resource: "pods"},
	{APIVersion: "v1", Kind: "ReplicationController", Resource: "replicationcontrollers"},
	{APIVersion: "apps/v1", Kind: "Deployment", Resource: "deployments"},
	{APIVersion: "apps/v1", Kind: "ReplicaSet", Resource: "replicasets"},
	{APIVersion: "apps/v1", Kind: "StatefulSet", Resource: "statefulsets"},
	{APIVersion: "apps/v1", Kind: "DaemonSet", Resource: "daemonsets"},
	{APIVersion: "batch/v1", Kind: "Job", Resource: "jobs"},
	{APIVersion: "batch/v1", Kind: "CronJob", Resource: "cronjobs"},
	{APIVersion: "v1", Kind: "PersistentVolumeClaim", Resource: "persistentvolumeclaims", Category: PVCs, MetadataOnly: true},
	{APIVersion: "v1", Kind: "ConfigMap", Resource: "configmaps", Category: ConfigMaps, MetadataOnly: true},
	{APIVersion: "v1", Kind: "Secret", Resource: "secrets", Category: Secrets, MetadataOnly: true},
	{APIVersion: "v1", Kind: "Service", Resource: "services", Category: Services},
	{APIVersion: "networking.k8s.io/v1", Kind: "Ingress", Resource: "ingresses", Category: Ingresses},
}

// CertificateSource is an optional adapter, listed when the cert-manager API
// is served.
var CertificateSource = &Source{APIVersion: "cert-manager.io/v1", Kind: "Certificate", Resource: "certificates", Category: Certificates}

// CNPGSource is an optional adapter: CNPG instances consume certificate and
// query resources through the API, so these references cannot be recovered
// from Pod volumes alone.
var CNPGSource = &Source{APIVersion: "postgresql.cnpg.io/v1", Kind: "Cluster", Resource: "clusters"}

// Object is a projected object: identity, owners, labels, the marker
// annotations the inventory uses and a spec reduced to references.
type Object struct {
	APIVersion  string
	Kind        string
	UID         string
	Name        string
	Namespace   string
	Labels      map[string]string
	Annotations map[string]string
	Owners      []metav1.OwnerReference
	Spec        map[string]any
	// OwnerReferenceOnly marks owners known only from a child's reference.
	OwnerReferenceOnly bool
}

// List holds the objects of one source in a namespace.
type List struct {
	Source  *Source
	Objects []*Object
}

// Dependencies are the names a workload references or owns, per category.
type Dependencies struct {
	Pods         []string `json:"pods,omitempty"`
	Images       []string `json:"images,omitempty"`
	ConfigMaps   []string `json:"configmaps,omitempty"`
	Secrets      []string `json:"secrets,omitempty"`
	PVCs         []string `json:"pvcs,omitempty"`
	Services     []string `json:"services,omitempty"`
	Ingresses    []string `json:"ingresses,omitempty"`
	Certificates []string `json:"certificates,omitempty"`
}

func (d *Dependencies) field(category Category) *[]string {
	switch category {
	case Pods:
		return &d.Pods
	case Images:
		return &d.Images
	case ConfigMaps:
		return &d.ConfigMaps
	case Secrets:
		return &d.Secrets
	case PVCs:
		return &d.PVCs
	case Services:
		return &d.Services
	case Ingresses:
		return &d.Ingresses
	case Certificates:
		return &d.Certificates
	}
	panic("unknown category " + string(category))
}

func (d *Dependencies) add(category Category, value any) {
	name, _ := value.(string)
	if name == "" {
		return
	}
	values := d.field(category)
	if !slices.Contains(*values, name) {
		*values = append(*values, name)
	}
}

func (d *Dependencies) has(category Category, name string) bool {
	return slices.Contains(*d.field(category), name)
}

func (d *Dependencies) empty() bool {
	for _, category := range categories {
		if len(*d.field(category)) > 0 {
			return false
		}
	}
	return true
}

func (d *Dependencies) sort() {
	for _, category := range categories {
		slices.Sort(*d.field(category))
	}
}

// Workload is a root owner with its dependencies. The namespace bucket,
// kind Namespace named orphaned-workloads, holds unclaimed resources.
type Workload struct {
	Name               string `json:"name"`
	Kind               string `json:"kind"`
	Namespace          string `json:"namespace"`
	APIVersion         string `json:"apiVersion,omitempty"`
	UID                string `json:"uid,omitempty"`
	OwnerReferenceOnly bool   `json:"ownerReferenceOnly,omitempty"`
	Dependencies
	StandalonePods []StandalonePod `json:"standalonePods,omitempty"`
	// Orphaned groups auxiliary generating owners of unclaimed resources by
	// Kind.api-group and name.
	Orphaned map[string]map[string]*OrphanOwner `json:"orphaned,omitempty"`
}

type StandalonePod struct {
	Name string `json:"name"`
	UID  string `json:"uid"`
}

type OrphanOwner struct {
	APIVersion         string `json:"apiVersion"`
	UID                string `json:"uid"`
	OwnerReferenceOnly bool   `json:"ownerReferenceOnly"`
	Dependencies
}

func group(apiVersion string) string {
	if g, _, found := strings.Cut(apiVersion, "/"); found {
		return g
	}
	return ""
}
