// Package workloads builds a live inventory of what runs in a namespace: root
// owners with their pods, images and the ConfigMaps, Secrets, PVCs, Services,
// Ingresses and Certificates they use, from a watch-backed cache that keeps
// references only.
package workloads

import (
	"time"

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

type SourceRepository struct {
	Name   string   `json:"name,omitempty"`
	URL    string   `json:"url"`
	Images []string `json:"images,omitempty"`
}

// Workload is a root owner, or the namespace's orphan bucket (kind
// Namespace, name orphaned-workloads).
type Workload struct {
	SourceRepositories   []SourceRepository `json:"sourceRepositories,omitempty"`
	DesiredReplicas      *int32             `json:"desiredReplicas,omitempty"`
	Completed            bool               `json:"completed,omitempty"`
	HelmReleaseName      string             `json:"helmReleaseName,omitempty"`
	HelmReleaseNamespace string             `json:"helmReleaseNamespace,omitempty"`
	HelmChart            string             `json:"helmChart,omitempty"`
	// Provenance labels and annotations, by key.
	Provenance map[string]string `json:"provenance,omitempty"`
	CreatedAt  *time.Time        `json:"createdAt,omitempty"`
	// The latest write to the object other than to its status, and the
	// field manager that made it.
	UpdatedAt          *time.Time `json:"updatedAt,omitempty"`
	UpdatedBy          string     `json:"updatedBy,omitempty"`
	Name               string     `json:"name"`
	Kind               string     `json:"kind"`
	Namespace          string     `json:"namespace"`
	APIVersion         string     `json:"apiVersion,omitempty"`
	UID                string     `json:"uid,omitempty"`
	OwnerReferenceOnly bool       `json:"ownerReferenceOnly,omitempty"`
	Dependencies
	StandalonePods []StandalonePod `json:"standalonePods,omitempty"`
	// Qualified kind ("Kind.group") -> owner name -> what it generated.
	Orphaned map[string]map[string]*OrphanOwner `json:"orphaned,omitempty"`
}

// Inventory is the caller's view of one or more namespaces.
type Inventory struct {
	Workloads []*Workload `json:"workloads"`
	Total     int         `json:"total"`
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
	DesiredReplicas *int32
	Completed       bool
	metav1.ObjectMeta
	APIVersion string
	Kind       string
	Spec       Spec
	Pod        *PodSnapshot
	// A custom owner known only from a child's ownerReference.
	OwnerReferenceOnly bool
}

// PodSnapshot is a small runtime inventory, without Pod specs, environment
// values, annotations or image filesystem metadata.
type PodSnapshot struct {
	Name                string         `json:"name"`
	Namespace           string         `json:"namespace"`
	UID                 string         `json:"uid"`
	CreatedAt           time.Time      `json:"createdAt"`
	NodeName            string         `json:"nodeName,omitempty"`
	Phase               string         `json:"phase"`
	IPs                 []string       `json:"ips,omitempty"`
	HasImagePullSecrets bool           `json:"hasImagePullSecrets"`
	Containers          []PodContainer `json:"containers"`
}
type PodContainer struct {
	Name    string `json:"name"`
	Image   string `json:"image"`
	ImageID string `json:"imageID,omitempty"`
}

// DeepCopyObject lets informer stores hold nodes; they are never mutated.
func (n *Node) DeepCopyObject() runtime.Object { return n }

func (n *Node) GetObjectKind() schema.ObjectKind { return schema.EmptyObjectKind }

// Annotations the inventory reads. Arbitrary annotations can hold secrets.
var keptAnnotations = []string{"meta.helm.sh/release-name", "meta.helm.sh/release-namespace", "kubernetes.io/config.mirror", "reflector.v1.k8s.emberstack.com/reflects",
	"codemowers.io/created-by", "argocd.argoproj.io/tracking-id"}

// Annotations and labels that record who or what created a root workload:
// the authenticated creator recorded by admission, and the deploy tools'
// own markers.
var provenanceKeys = []string{"codemowers.io/created-by", "argocd.argoproj.io/tracking-id", "skaffold.dev/run-id",
	"helm.toolkit.fluxcd.io/namespace", "helm.toolkit.fluxcd.io/name", "app.kubernetes.io/managed-by"}

// times reports when a node was created and last written to, and by which
// field manager; an owner known only from a reference has neither.
func times(n *Node) (created, updated *time.Time, by string) {
	if !n.CreationTimestamp.IsZero() {
		t := n.CreationTimestamp.UTC()
		created = &t
	}
	if len(n.ManagedFields) > 0 {
		t := n.ManagedFields[0].Time.UTC()
		updated, by = &t, n.ManagedFields[0].Manager
	}

	return created, updated, by
}

func provenance(n *Node) map[string]string {
	var out map[string]string
	for _, k := range provenanceKeys {
		v, ok := n.Annotations[k]
		if !ok {
			v, ok = n.Labels[k]
		}
		if ok && v != "" {
			if out == nil {
				out = map[string]string{}
			}
			out[k] = v
		}
	}

	return out
}

func groupOf(apiVersion string) string {
	if g, _, ok := strings.Cut(apiVersion, "/"); ok {
		return g
	}

	return ""
}
