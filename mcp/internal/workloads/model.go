// Package workloads builds a live inventory of what runs in a namespace: root
// owners with their pods, images and the ConfigMaps, Secrets, PVCs, Services,
// Ingresses and Certificates they use, from a watch-backed cache that keeps
// references only.
package workloads

import (
	"slices"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// Category names a dependency list on a workload.
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

// Dependencies are the names a workload uses, per category. Empty lists are
// omitted on the wire.
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

func (d *Dependencies) list(c Category) *[]string {
	switch c {
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
	default:
		return &d.Certificates
	}
}

func (d *Dependencies) add(c Category, value string) {
	if value == "" {
		return
	}
	if l := d.list(c); !slices.Contains(*l, value) {
		*l = append(*l, value)
	}
}

func (d *Dependencies) has(c Category, value string) bool {
	return slices.Contains(*d.list(c), value)
}

func (d *Dependencies) empty() bool {
	for _, c := range categories {
		if len(*d.list(c)) > 0 {
			return false
		}
	}

	return true
}

func (d *Dependencies) sort() {
	for _, c := range categories {
		slices.Sort(*d.list(c))
	}
}

type StandalonePod struct {
	Name string `json:"name"`
	UID  string `json:"uid"`
}

// OrphanOwner is an auxiliary generating owner of orphaned objects.
type OrphanOwner struct {
	APIVersion         string `json:"apiVersion"`
	UID                string `json:"uid"`
	OwnerReferenceOnly bool   `json:"ownerReferenceOnly"`
	Dependencies
}

// Workload is a root owner, or the namespace's orphan bucket (kind
// Namespace, name orphaned-workloads).
type Workload struct {
	Name               string `json:"name"`
	Kind               string `json:"kind"`
	Namespace          string `json:"namespace"`
	APIVersion         string `json:"apiVersion,omitempty"`
	UID                string `json:"uid,omitempty"`
	OwnerReferenceOnly bool   `json:"ownerReferenceOnly,omitempty"`
	Dependencies
	StandalonePods []StandalonePod `json:"standalonePods,omitempty"`
	// Qualified kind ("Kind.group") -> owner name -> what it generated.
	Orphaned map[string]map[string]*OrphanOwner `json:"orphaned,omitempty"`
}

// Inventory is the caller's view of one or more namespaces.
type Inventory struct {
	Workloads []*Workload `json:"workloads"`
	Warnings  []string    `json:"warnings,omitempty"`
	// Opaque; changes whenever the cached cluster state does.
	Revision string `json:"revision,omitempty"`
}

// Source is one collection the cache watches.
type Source struct {
	GVR  schema.GroupVersionResource
	Kind string
	// Set for dependency collections; workload controllers have none.
	Category Category
	// Read as PartialObjectMetadata: their data never enters memory.
	MetadataOnly bool
}

func (s Source) APIVersion() string {
	return s.GVR.GroupVersion().String()
}

// Sources are the built-in collections, watched cluster-wide.
var Sources = []Source{
	{GVR: schema.GroupVersionResource{Version: "v1", Resource: "pods"}, Kind: "Pod"},
	{GVR: schema.GroupVersionResource{Version: "v1", Resource: "replicationcontrollers"}, Kind: "ReplicationController"},
	{GVR: schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}, Kind: "Deployment"},
	{GVR: schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "replicasets"}, Kind: "ReplicaSet"},
	{GVR: schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "statefulsets"}, Kind: "StatefulSet"},
	{GVR: schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "daemonsets"}, Kind: "DaemonSet"},
	{GVR: schema.GroupVersionResource{Group: "batch", Version: "v1", Resource: "jobs"}, Kind: "Job"},
	{GVR: schema.GroupVersionResource{Group: "batch", Version: "v1", Resource: "cronjobs"}, Kind: "CronJob"},
	{GVR: schema.GroupVersionResource{Version: "v1", Resource: "persistentvolumeclaims"}, Kind: "PersistentVolumeClaim", Category: PVCs, MetadataOnly: true},
	{GVR: schema.GroupVersionResource{Version: "v1", Resource: "configmaps"}, Kind: "ConfigMap", Category: ConfigMaps, MetadataOnly: true},
	{GVR: schema.GroupVersionResource{Version: "v1", Resource: "secrets"}, Kind: "Secret", Category: Secrets, MetadataOnly: true},
	{GVR: schema.GroupVersionResource{Version: "v1", Resource: "services"}, Kind: "Service", Category: Services},
	{GVR: schema.GroupVersionResource{Group: "networking.k8s.io", Version: "v1", Resource: "ingresses"}, Kind: "Ingress", Category: Ingresses},
}

// Optional fixed adapters, watched only when discovery serves them. Other
// custom owners are terminal labels from ownerReferences and never watched.
var (
	CertificateSource = Source{GVR: schema.GroupVersionResource{Group: "cert-manager.io", Version: "v1", Resource: "certificates"}, Kind: "Certificate", Category: Certificates}
	// CNPG instances consume certificate and query resources through the API,
	// so these references cannot be recovered from pod volumes alone.
	CNPGSource = Source{GVR: schema.GroupVersionResource{Group: "postgresql.cnpg.io", Version: "v1", Resource: "clusters"}, Kind: "Cluster"}
)

// PodRefs are the references a pod spec makes, never environment values,
// commands or credentials.
type PodRefs struct {
	Images     []string
	ConfigMaps []string
	Secrets    []string
	PVCs       []string
	// Names of generic ephemeral volumes; their PVC is <pod>-<volume>.
	EphemeralVolumes []string
}

// Spec is the part of an object's spec the graph uses.
type Spec struct {
	// A Pod's own spec, or a controller's pod template.
	Pod            *PodRefs
	TemplateLabels map[string]string
	// StatefulSet
	ServiceName    string
	ClaimTemplates []string
	// Service
	Selector map[string]string
	// Ingress
	BackendServices []string
	TLSSecrets      []string
	// Certificate
	SecretName string
	// CNPG Cluster
	ReferencedSecrets    []string
	ReferencedConfigMaps []string
}

// Node is a cached object, reduced to identity, ownership, the two
// annotations the inventory reads, and reference fields.
type Node struct {
	metav1.ObjectMeta
	APIVersion string
	Kind       string
	Spec       Spec
	// A custom owner known only from a child's ownerReference.
	OwnerReferenceOnly bool
}

// DeepCopyObject lets informer stores hold nodes; they are never mutated.
func (n *Node) DeepCopyObject() runtime.Object { return n }

func (n *Node) GetObjectKind() schema.ObjectKind { return schema.EmptyObjectKind }

// Annotations the inventory reads. Arbitrary annotations can hold secrets.
var keptAnnotations = []string{"kubernetes.io/config.mirror", "reflector.v1.k8s.emberstack.com/reflects"}

func groupOf(apiVersion string) string {
	if g, _, ok := strings.Cut(apiVersion, "/"); ok {
		return g
	}

	return ""
}
