package catalog

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/codemowers/driftmower-mcp/internal/kube"
)

var crds = schema.GroupVersionResource{Group: "apiextensions.k8s.io", Version: "v1", Resource: "customresourcedefinitions"}

type CRDVersion struct {
	Name    string `json:"name"`
	Served  bool   `json:"served"`
	Storage bool   `json:"storage"`
}

// CustomResource identifies an installed custom-resource API.
type CustomResource struct {
	Name        string       `json:"name"`
	Description *string      `json:"description"`
	Group       string       `json:"group"`
	Kind        string       `json:"kind"`
	Resource    string       `json:"resource"`
	Scope       string       `json:"scope"`
	Versions    []CRDVersion `json:"versions"`
	Established bool         `json:"established"`
	Terminating bool         `json:"terminating"`
}

type crdObject struct {
	Metadata ObjectMeta `json:"metadata"`
	Spec     struct {
		Group string `json:"group"`
		Names struct {
			Kind   string `json:"kind"`
			Plural string `json:"plural"`
		} `json:"names"`
		Scope    string `json:"scope"`
		Versions []struct {
			CRDVersion
			Schema *struct {
				OpenAPIV3Schema map[string]any `json:"openAPIV3Schema"`
			} `json:"schema,omitempty"`
		} `json:"versions"`
	} `json:"spec"`
	Status struct {
		Conditions []condition `json:"conditions"`
	} `json:"status"`
}

// CustomResourceDefinitions lists installed CRDs, sorted by name. A failure
// here must never look like a cluster without CRDs, so it is returned.
func (c *Catalog) CustomResourceDefinitions(ctx context.Context) ([]CustomResource, error) {
	items, err := kube.ListUnstructured[crdObject](ctx, c.dyn, crds, "", smallPages)
	if err != nil {
		return nil, err
	}
	out := make([]CustomResource, 0, len(items))
	for _, i := range items {
		versions := make([]CRDVersion, len(i.Spec.Versions))
		for n, v := range i.Spec.Versions {
			versions[n] = v.CRDVersion
		}
		out = append(out, CustomResource{
			Name:        i.Metadata.Name,
			Description: i.Metadata.description(),
			Group:       i.Spec.Group,
			Kind:        i.Spec.Names.Kind,
			Resource:    i.Spec.Names.Plural,
			Scope:       i.Spec.Scope,
			Versions:    versions,
			Established: slices.Contains(i.Status.Conditions, condition{Type: "Established", Status: "True"}),
			Terminating: i.Metadata.DeletionTimestamp != nil,
		})
	}
	slices.SortFunc(out, func(a, b CustomResource) int { return strings.Compare(a.Name, b.Name) })

	return out, nil
}

// PreferredServedVersion picks v1 when served, else the first served version.
func (r CustomResource) PreferredServedVersion() string {
	first := ""
	for _, v := range r.Versions {
		if !v.Served {
			continue
		}
		if v.Name == "v1" {
			return v.Name
		}
		if first == "" {
			first = v.Name
		}
	}

	return first
}

type CRDSchemaVersion struct {
	Name   string         `json:"name"`
	Schema map[string]any `json:"schema"`
}

type CRDDetails struct {
	Name        string             `json:"name"`
	Description *string            `json:"description"`
	Group       string             `json:"group"`
	Kind        string             `json:"kind"`
	Resource    string             `json:"resource"`
	Scope       string             `json:"scope"`
	Versions    []CRDSchemaVersion `json:"versions"`
}

// DescribeCRD returns the served versions and writable schemas of one CRD.
// It lists by field selector rather than getting by name, because this
// server's ClusterRole grants list and watch on CRDs, not get.
func (c *Catalog) DescribeCRD(ctx context.Context, name string) (CRDDetails, error) {
	list, err := c.dyn.Resource(crds).List(ctx, metav1.ListOptions{FieldSelector: "metadata.name=" + name})
	if err != nil {
		return CRDDetails{}, err
	}
	i := slices.IndexFunc(list.Items, func(u unstructured.Unstructured) bool { return u.GetName() == name })
	if i < 0 {
		return CRDDetails{}, fmt.Errorf("CRD not found: %s", name)
	}
	raw, err := json.Marshal(list.Items[i].Object)
	if err != nil {
		return CRDDetails{}, err
	}
	var obj crdObject
	if err := json.Unmarshal(raw, &obj); err != nil {
		return CRDDetails{}, err
	}

	d := CRDDetails{
		Name:        obj.Metadata.Name,
		Description: obj.Metadata.description(),
		Group:       obj.Spec.Group,
		Kind:        obj.Spec.Names.Kind,
		Resource:    obj.Spec.Names.Plural,
		Scope:       obj.Spec.Scope,
		Versions:    []CRDSchemaVersion{},
	}
	for _, v := range obj.Spec.Versions {
		if !v.Served {
			continue
		}
		version := CRDSchemaVersion{Name: v.Name}
		if v.Schema != nil {
			version.Schema, _ = cleanSchema(v.Schema.OpenAPIV3Schema).(map[string]any)
		}
		d.Versions = append(d.Versions, version)
	}

	return d, nil
}

// cleanSchema keeps the schema's structure but omits server-owned status and
// embedded CEL.
func cleanSchema(value any) any {
	switch v := value.(type) {
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = cleanSchema(item)
		}

		return out
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, child := range v {
			switch key {
			case "x-kubernetes-validations":
			case "properties":
				if props, ok := child.(map[string]any); ok {
					cleaned := make(map[string]any, len(props))
					for name, s := range props {
						if name != "status" {
							cleaned[name] = cleanSchema(s)
						}
					}
					out[key] = cleaned
				} else {
					out[key] = cleanSchema(child)
				}
			case "required":
				if names, ok := child.([]any); ok {
					out[key] = slices.DeleteFunc(slices.Clone(names), func(n any) bool { return n == "status" })
				} else {
					out[key] = child
				}
			default:
				out[key] = cleanSchema(child)
			}
		}

		return out
	default:
		return value
	}
}
