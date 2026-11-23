// Package catalog reads cluster-scoped catalogs: storage classes, admission
// policies and their bindings, custom resource definitions, ingress classes,
// priority classes and cluster issuers. It exposes settings directly from the
// API rather than inferring them from prose, and returns no tenant objects or
// credentials.
package catalog

import (
	"context"
	"slices"
	"strings"

	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"

	"github.com/codemowers/driftmower/mcp/internal/kube"
	"github.com/codemowers/driftmower/mcp/internal/nonnil"
)

type Catalog struct {
	k   kubernetes.Interface
	dyn dynamic.Interface
}

func New(k kubernetes.Interface, dyn dynamic.Interface) *Catalog {
	return &Catalog{k: k, dyn: dyn}
}

type ObjectMeta struct {
	Name              string            `json:"name"`
	Annotations       map[string]string `json:"annotations,omitempty"`
	DeletionTimestamp *string           `json:"deletionTimestamp,omitempty"`
}

func (m ObjectMeta) description() *string {
	if d, ok := m.Annotations["kubernetes.io/description"]; ok {
		return &d
	}

	return nil
}

type TopologySelectorTerm struct {
	MatchLabelExpressions []TopologyRequirement `json:"matchLabelExpressions"`
}

type TopologyRequirement struct {
	Key    string   `json:"key"`
	Values []string `json:"values"`
}

type StorageClass struct {
	Name                 string                 `json:"name"`
	Description          *string                `json:"description"`
	Provisioner          *string                `json:"provisioner"`
	FilesystemType       *string                `json:"filesystemType"`
	Parameters           map[string]string      `json:"parameters"`
	ReclaimPolicy        *string                `json:"reclaimPolicy"`
	VolumeBindingMode    *string                `json:"volumeBindingMode"`
	AllowVolumeExpansion bool                   `json:"allowVolumeExpansion"`
	IsDefault            bool                   `json:"-"`
	MountOptions         []string               `json:"mountOptions"`
	AllowedTopologies    []TopologySelectorTerm `json:"allowedTopologies"`
}

var storageClasses = schema.GroupVersionResource{Group: "storage.k8s.io", Version: "v1", Resource: "storageclasses"}

// StorageClasses lists every StorageClass, sorted by name. IsDefault is kept
// for provisioning decisions but not serialised: the response catalogs omit
// the redundant flag.
func (c *Catalog) StorageClasses(ctx context.Context) ([]StorageClass, error) {
	type raw struct {
		Metadata             ObjectMeta             `json:"metadata"`
		Provisioner          string                 `json:"provisioner"`
		Parameters           map[string]string      `json:"parameters"`
		ReclaimPolicy        string                 `json:"reclaimPolicy"`
		VolumeBindingMode    string                 `json:"volumeBindingMode"`
		AllowVolumeExpansion bool                   `json:"allowVolumeExpansion"`
		MountOptions         []string               `json:"mountOptions"`
		AllowedTopologies    []TopologySelectorTerm `json:"allowedTopologies"`
	}
	items, err := kube.ListUnstructured[raw](ctx, c.dyn, storageClasses, "", kube.ListOptions{What: "Cluster catalog"})
	if err != nil {
		return nil, err
	}

	out := make([]StorageClass, 0, len(items))
	for _, r := range items {
		params := r.Parameters
		if params == nil {
			params = map[string]string{}
		}
		var fsType *string
		for _, key := range []string{"csi.storage.k8s.io/fstype", "fsType", "fstype"} {
			if v, ok := params[key]; ok {
				fsType = &v

				break
			}
		}
		a := r.Metadata.Annotations
		out = append(out, StorageClass{
			Name:                 r.Metadata.Name,
			Description:          r.Metadata.description(),
			Provisioner:          nonnil.String(r.Provisioner),
			FilesystemType:       fsType,
			Parameters:           params,
			ReclaimPolicy:        nonnil.String(r.ReclaimPolicy),
			VolumeBindingMode:    nonnil.String(r.VolumeBindingMode),
			AllowVolumeExpansion: r.AllowVolumeExpansion,
			IsDefault: a["storageclass.kubernetes.io/is-default-class"] == "true" ||
				a["storageclass.beta.kubernetes.io/is-default-class"] == "true",
			MountOptions:      nonnil.Slice(r.MountOptions),
			AllowedTopologies: nonnil.Slice(r.AllowedTopologies),
		})
	}
	slices.SortFunc(out, func(a, b StorageClass) int { return strings.Compare(a.Name, b.Name) })

	return out, nil
}

type IngressClass struct {
	Name       string `json:"name"`
	Controller string `json:"controller"`
	IsDefault  bool   `json:"isDefault"`
}

type PriorityClass struct {
	Name        string  `json:"name"`
	Value       int32   `json:"value"`
	IsDefault   bool    `json:"isDefault"`
	Description *string `json:"description"`
}

type ACMESolvers struct {
	HTTP01 bool `json:"http01"`
	DNS01  bool `json:"dns01"`
}

type ClusterIssuer struct {
	Name        string  `json:"name"`
	Description *string `json:"description"`
	// Its Ready condition; nil when it reports none.
	Ready *bool `json:"ready"`
	// Challenge types the solvers offer; nil for non-ACME issuers.
	ACME *ACMESolvers `json:"acme"`
}

type Degraded struct {
	Source  string `json:"source"`
	Message string `json:"message"`
}

// PlatformClasses holds the class catalogs; a nil list could not be read.
type PlatformClasses struct {
	IngressClasses  []IngressClass
	PriorityClasses []PriorityClass
	ClusterIssuers  []ClusterIssuer
	Degraded        []Degraded
}

// Which catalog PlatformClasses reads; "" reads all of them.
const (
	OnlyIngressClasses  = "ingressclasses"
	OnlyPriorityClasses = "priorityclasses"
	OnlyClusterIssuers  = "clusterissuers"
)

var (
	ingressClasses  = schema.GroupVersionResource{Group: "networking.k8s.io", Version: "v1", Resource: "ingressclasses"}
	priorityClasses = schema.GroupVersionResource{Group: "scheduling.k8s.io", Version: "v1", Resource: "priorityclasses"}
)

// CRD schemas can be large, so CRD and class lists page in small batches.
var smallPages = kube.ListOptions{Limit: 10, MaxPages: 200, What: "Cluster capability discovery"}

type condition struct {
	Type   string `json:"type"`
	Status string `json:"status"`
}

// PlatformClasses reads ingress classes, priority classes and, when
// cert-manager serves issuerVersion, cluster issuers. A failed read degrades
// its own catalog only.
func (c *Catalog) PlatformClasses(ctx context.Context, issuerVersion, only string) PlatformClasses {
	var out PlatformClasses
	fail := func(source string, err error) {
		out.Degraded = append(out.Degraded, Degraded{Source: source, Message: err.Error()})
	}

	if only == "" || only == OnlyIngressClasses {
		type raw struct {
			Metadata ObjectMeta `json:"metadata"`
			Spec     struct {
				Controller string `json:"controller"`
			} `json:"spec"`
		}
		if items, err := kube.ListUnstructured[raw](ctx, c.dyn, ingressClasses, "", smallPages); err != nil {
			fail(OnlyIngressClasses, err)
		} else {
			out.IngressClasses = []IngressClass{}
			for _, i := range items {
				out.IngressClasses = append(out.IngressClasses, IngressClass{
					Name:       i.Metadata.Name,
					Controller: i.Spec.Controller,
					IsDefault:  i.Metadata.Annotations["ingressclass.kubernetes.io/is-default-class"] == "true",
				})
			}
		}
	}

	if only == "" || only == OnlyPriorityClasses {
		type raw struct {
			Metadata      ObjectMeta `json:"metadata"`
			Value         int32      `json:"value"`
			GlobalDefault bool       `json:"globalDefault"`
			Description   string     `json:"description"`
		}
		if items, err := kube.ListUnstructured[raw](ctx, c.dyn, priorityClasses, "", smallPages); err != nil {
			fail(OnlyPriorityClasses, err)
		} else {
			out.PriorityClasses = []PriorityClass{}
			for _, i := range items {
				out.PriorityClasses = append(out.PriorityClasses, PriorityClass{
					Name: i.Metadata.Name, Value: i.Value, IsDefault: i.GlobalDefault, Description: nonnil.String(i.Description),
				})
			}
			slices.SortFunc(out.PriorityClasses, func(a, b PriorityClass) int {
				if a.Value != b.Value {
					return int(a.Value) - int(b.Value)
				}

				return strings.Compare(a.Name, b.Name)
			})
		}
	}

	if (only == "" || only == OnlyClusterIssuers) && issuerVersion != "" {
		type raw struct {
			Metadata ObjectMeta `json:"metadata"`
			Spec     struct {
				ACME *struct {
					Solvers []map[string]any `json:"solvers"`
				} `json:"acme"`
			} `json:"spec"`
			Status struct {
				Conditions []condition `json:"conditions"`
			} `json:"status"`
		}
		gvr := schema.GroupVersionResource{Group: "cert-manager.io", Version: issuerVersion, Resource: "clusterissuers"}
		if items, err := kube.ListUnstructured[raw](ctx, c.dyn, gvr, "", smallPages); err != nil {
			fail(OnlyClusterIssuers, err)
		} else {
			out.ClusterIssuers = []ClusterIssuer{}
			for _, i := range items {
				issuer := ClusterIssuer{Name: i.Metadata.Name, Description: i.Metadata.description()}
				for _, cond := range i.Status.Conditions {
					if cond.Type == "Ready" {
						switch cond.Status {
						case "True":
							issuer.Ready = new(true)
						case "False":
							issuer.Ready = new(false)
						}

						break
					}
				}
				if i.Spec.ACME != nil {
					issuer.ACME = &ACMESolvers{}
					for _, s := range i.Spec.ACME.Solvers {
						_, http := s["http01"]
						_, dns := s["dns01"]
						issuer.ACME.HTTP01 = issuer.ACME.HTTP01 || http
						issuer.ACME.DNS01 = issuer.ACME.DNS01 || dns
					}
				}
				out.ClusterIssuers = append(out.ClusterIssuers, issuer)
			}
		}
	} else if only == "" || only == OnlyClusterIssuers {
		out.ClusterIssuers = []ClusterIssuer{}
	}

	if out.Degraded == nil {
		out.Degraded = []Degraded{}
	}
	slices.SortFunc(out.Degraded, func(a, b Degraded) int { return strings.Compare(a.Source, b.Source) })

	return out
}

// groupVersions lists the versions the API server serves for a group, in
// its preference order.
func (c *Catalog) groupVersions(group string) ([]string, error) {
	groups, err := c.k.Discovery().ServerGroups()
	if err != nil {
		return nil, err
	}
	for _, g := range groups.Groups {
		if g.Name == group {
			versions := make([]string, len(g.Versions))
			for i, v := range g.Versions {
				versions[i] = v.Version
			}

			return versions, nil
		}
	}

	return nil, nil
}
