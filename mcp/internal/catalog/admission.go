package catalog

import (
	"context"
	"slices"
	"strings"

	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/codemowers/driftmower-mcp/internal/kube"
	"github.com/codemowers/driftmower-mcp/internal/provisioning"
)

// The admission policy specs as served. This is inspection, not CEL
// evaluation or a prediction of effective admission behaviour.

type Rule struct {
	APIGroups     []string `json:"apiGroups,omitempty"`
	APIVersions   []string `json:"apiVersions,omitempty"`
	Operations    []string `json:"operations,omitempty"`
	Resources     []string `json:"resources,omitempty"`
	ResourceNames []string `json:"resourceNames,omitempty"`
	Scope         string   `json:"scope,omitempty"`
}

type Matching struct {
	MatchPolicy          string                      `json:"matchPolicy,omitempty"`
	NamespaceSelector    *provisioning.LabelSelector `json:"namespaceSelector,omitempty"`
	ObjectSelector       *provisioning.LabelSelector `json:"objectSelector,omitempty"`
	ResourceRules        []Rule                      `json:"resourceRules,omitempty"`
	ExcludeResourceRules []Rule                      `json:"excludeResourceRules,omitempty"`
}

type AdmissionSpec struct {
	FailurePolicy    string                    `json:"failurePolicy,omitempty"`
	MatchConstraints *Matching                 `json:"matchConstraints,omitempty"`
	MatchConditions  []provisioning.Expression `json:"matchConditions,omitempty"`
	Variables        []provisioning.Expression `json:"variables,omitempty"`
	ParamKind        *struct {
		APIVersion string `json:"apiVersion"`
		Kind       string `json:"kind"`
	} `json:"paramKind,omitempty"`
	Validations []provisioning.Expression `json:"validations,omitempty"`
}

type BindingSpec struct {
	PolicyName        string    `json:"policyName"`
	ValidationActions []string  `json:"validationActions,omitempty"`
	MatchResources    *Matching `json:"matchResources,omitempty"`
	ParamRef          *struct {
		Name      string `json:"name,omitempty"`
		Namespace string `json:"namespace,omitempty"`
	} `json:"paramRef,omitempty"`
}

type Binding struct {
	Name        string      `json:"name"`
	Description *string     `json:"description"`
	Kind        string      `json:"kind"`
	APIVersion  string      `json:"apiVersion"`
	Spec        BindingSpec `json:"spec"`
}

type AdmissionPolicy struct {
	Name        string            `json:"name"`
	Description *string           `json:"description"`
	Kind        string            `json:"kind"`
	APIVersion  string            `json:"apiVersion"`
	Annotations map[string]string `json:"annotations"`
	Spec        AdmissionSpec     `json:"spec"`
	// Nil means the binding API is unavailable; empty means it was read and
	// no binding references this policy.
	Bindings []Binding `json:"bindings"`
}

type AdmissionPolicies struct {
	Policies         []AdmissionPolicy
	UnavailableKinds []string
}

const admissionGroup = "admissionregistration.k8s.io"

var policyResources = []struct{ name, kind, bindingName, bindingKind string }{
	{"validatingadmissionpolicies", "ValidatingAdmissionPolicy", "validatingadmissionpolicybindings", "ValidatingAdmissionPolicyBinding"},
	{"mutatingadmissionpolicies", "MutatingAdmissionPolicy", "mutatingadmissionpolicybindings", "MutatingAdmissionPolicyBinding"},
}

// AdmissionPolicies lists validating and mutating admission policies with
// their bindings joined, from the most stable version the cluster serves each
// at.
func (c *Catalog) AdmissionPolicies(ctx context.Context) (AdmissionPolicies, error) {
	served, err := c.groupVersions(admissionGroup)
	if err != nil {
		return AdmissionPolicies{}, err
	}

	versionOf := map[string]string{}
	wanted := len(policyResources) * 2
	for _, version := range []string{"v1", "v1beta1", "v1alpha1"} {
		if !slices.Contains(served, version) {
			continue
		}
		list, err := c.k.Discovery().ServerResourcesForGroupVersion(admissionGroup + "/" + version)
		if err != nil {
			return AdmissionPolicies{}, err
		}
		for _, r := range list.APIResources {
			if _, ok := versionOf[r.Name]; !ok && slices.Contains(r.Verbs, "list") {
				versionOf[r.Name] = version
			}
		}
		if len(versionOf) >= wanted {
			break
		}
	}

	out := AdmissionPolicies{Policies: []AdmissionPolicy{}, UnavailableKinds: []string{}}
	for _, res := range policyResources {
		version, ok := versionOf[res.name]
		if !ok {
			out.UnavailableKinds = append(out.UnavailableKinds, res.kind)

			continue
		}

		var bindings []Binding
		if bv, ok := versionOf[res.bindingName]; ok {
			type raw struct {
				Metadata ObjectMeta  `json:"metadata"`
				Spec     BindingSpec `json:"spec"`
			}
			items, err := kube.ListUnstructured[raw](ctx, c.dyn,
				schema.GroupVersionResource{Group: admissionGroup, Version: bv, Resource: res.bindingName}, "", kube.ListOptions{What: "Cluster catalog"})
			if err != nil {
				return AdmissionPolicies{}, err
			}
			bindings = []Binding{}
			for _, b := range items {
				bindings = append(bindings, Binding{
					Name: b.Metadata.Name, Description: b.Metadata.description(), Kind: res.bindingKind,
					APIVersion: admissionGroup + "/" + bv, Spec: b.Spec,
				})
			}
			slices.SortFunc(bindings, func(a, b Binding) int { return strings.Compare(a.Name, b.Name) })
		}

		type raw struct {
			Metadata ObjectMeta    `json:"metadata"`
			Spec     AdmissionSpec `json:"spec"`
		}
		items, err := kube.ListUnstructured[raw](ctx, c.dyn,
			schema.GroupVersionResource{Group: admissionGroup, Version: version, Resource: res.name}, "", kube.ListOptions{What: "Cluster catalog"})
		if err != nil {
			return AdmissionPolicies{}, err
		}
		policies := make([]AdmissionPolicy, 0, len(items))
		for _, p := range items {
			policy := AdmissionPolicy{
				Name: p.Metadata.Name, Description: p.Metadata.description(), Kind: res.kind,
				APIVersion: admissionGroup + "/" + version, Annotations: p.Metadata.Annotations, Spec: p.Spec,
			}
			if policy.Annotations == nil {
				policy.Annotations = map[string]string{}
			}
			if bindings != nil {
				policy.Bindings = []Binding{}
				for _, b := range bindings {
					if b.Spec.PolicyName == p.Metadata.Name {
						policy.Bindings = append(policy.Bindings, b)
					}
				}
			}
			policies = append(policies, policy)
		}
		slices.SortFunc(policies, func(a, b AdmissionPolicy) int { return strings.Compare(a.Name, b.Name) })
		out.Policies = append(out.Policies, policies...)
	}

	return out, nil
}

// Facts projects the catalog onto the provisioning fact inputs.
func (p AdmissionPolicies) Facts() ([]provisioning.AdmissionPolicyFact, []provisioning.MutationFact) {
	var validating []provisioning.AdmissionPolicy
	var vBindings []provisioning.AdmissionBinding
	var mutating []provisioning.MutatingPolicy
	var mBindings []provisioning.MutatingBinding

	for _, policy := range p.Policies {
		m := policy.Spec.MatchConstraints
		if m == nil {
			m = &Matching{}
		}
		switch policy.Kind {
		case "ValidatingAdmissionPolicy":
			validating = append(validating, provisioning.AdmissionPolicy{
				Name:            policy.Name,
				Annotations:     policy.Annotations,
				MatchPolicy:     m.MatchPolicy,
				ResourceRules:   toRules(m.ResourceRules),
				MatchConditions: policy.Spec.MatchConditions,
				Variables:       policy.Spec.Variables,
				Validations:     policy.Spec.Validations,
			})
			for _, b := range policy.Bindings {
				binding := provisioning.AdmissionBinding{PolicyName: b.Spec.PolicyName, ValidationActions: b.Spec.ValidationActions}
				if b.Spec.MatchResources != nil {
					binding.NamespaceSelector = b.Spec.MatchResources.NamespaceSelector
				}
				if b.Spec.ParamRef != nil {
					binding.ParamRefName, binding.ParamRefNamespace = b.Spec.ParamRef.Name, b.Spec.ParamRef.Namespace
				}
				vBindings = append(vBindings, binding)
			}
		case "MutatingAdmissionPolicy":
			description := ""
			if policy.Description != nil {
				description = *policy.Description
			}
			mutating = append(mutating, provisioning.MutatingPolicy{
				Name: policy.Name, Description: description, MatchPolicy: m.MatchPolicy,
				ResourceRules: toRules(m.ResourceRules), NamespaceSelector: m.NamespaceSelector,
			})
			for _, b := range policy.Bindings {
				binding := provisioning.MutatingBinding{PolicyName: b.Spec.PolicyName}
				if b.Spec.MatchResources != nil {
					binding.NamespaceSelector = b.Spec.MatchResources.NamespaceSelector
				}
				mBindings = append(mBindings, binding)
			}
		}
	}

	return provisioning.ToAdmissionFacts(validating, vBindings), provisioning.ToMutationFacts(mutating, mBindings)
}

func toRules(rules []Rule) []provisioning.ResourceRule {
	out := make([]provisioning.ResourceRule, len(rules))
	for i, r := range rules {
		out[i] = provisioning.ResourceRule{APIGroups: r.APIGroups, APIVersions: r.APIVersions, Operations: r.Operations, Resources: r.Resources}
	}

	return out
}
