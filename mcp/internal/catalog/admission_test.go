package catalog

import (
	"context"
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	fakediscovery "k8s.io/client-go/discovery/fake"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
)

func TestAdmissionPoliciesSearchOlderVersionsPastWebhooks(t *testing.T) {
	k := fake.NewClientset()
	list := []string{"list"}
	k.Discovery().(*fakediscovery.FakeDiscovery).Resources = []*metav1.APIResourceList{
		{GroupVersion: admissionGroup + "/v1", APIResources: []metav1.APIResource{
			{Name: "validatingadmissionpolicies", Kind: "ValidatingAdmissionPolicy", Verbs: list},
			{Name: "validatingadmissionpolicybindings", Kind: "ValidatingAdmissionPolicyBinding", Verbs: list},
			{Name: "validatingwebhookconfigurations", Kind: "ValidatingWebhookConfiguration", Verbs: list},
			{Name: "mutatingwebhookconfigurations", Kind: "MutatingWebhookConfiguration", Verbs: list},
		}},
		{GroupVersion: admissionGroup + "/v1beta1", APIResources: []metav1.APIResource{
			{Name: "mutatingadmissionpolicies", Kind: "MutatingAdmissionPolicy", Verbs: list},
			{Name: "mutatingadmissionpolicybindings", Kind: "MutatingAdmissionPolicyBinding", Verbs: list},
		}},
	}
	gvr := func(version, resource string) schema.GroupVersionResource {
		return schema.GroupVersionResource{Group: admissionGroup, Version: version, Resource: resource}
	}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{
		gvr("v1", "validatingadmissionpolicies"):          "ValidatingAdmissionPolicyList",
		gvr("v1", "validatingadmissionpolicybindings"):    "ValidatingAdmissionPolicyBindingList",
		gvr("v1beta1", "mutatingadmissionpolicies"):       "MutatingAdmissionPolicyList",
		gvr("v1beta1", "mutatingadmissionpolicybindings"): "MutatingAdmissionPolicyBindingList",
	}, &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": admissionGroup + "/v1beta1", "kind": "MutatingAdmissionPolicy",
		"metadata": map[string]any{"name": "default-labels"},
	}})

	got, err := New(k, dyn).AdmissionPolicies(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got.UnavailableKinds) != 0 {
		t.Errorf("unavailable = %v", got.UnavailableKinds)
	}
	if len(got.Policies) != 1 || got.Policies[0].APIVersion != admissionGroup+"/v1beta1" || got.Policies[0].Bindings == nil {
		t.Errorf("policies = %+v", got.Policies)
	}
}

func TestAdmissionPolicyTargets(t *testing.T) {
	rules := func(r ...Rule) *Matching { return &Matching{ResourceRules: r} }
	ingress := Rule{APIGroups: []string{"networking.k8s.io"}, Resources: []string{"ingresses"}}
	for _, tc := range []struct {
		name            string
		match           *Matching
		group, resource string
		anyGroup        bool
		want            bool
	}{
		{"no constraints match everything", nil, "apps", "deployments", false, true},
		{"no rules match everything", &Matching{}, "apps", "deployments", false, true},
		{"exact group and resource", rules(ingress), "networking.k8s.io", "ingresses", false, true},
		{"other resource", rules(ingress), "networking.k8s.io", "networkpolicies", false, false},
		{"other group", rules(ingress), "extensions", "ingresses", false, false},
		{"unqualified matches any group", rules(ingress), "", "ingresses", true, true},
		{"wildcards", rules(Rule{APIGroups: []string{"*"}, Resources: []string{"*"}}), "apps", "deployments", false, true},
		{"core group", rules(Rule{APIGroups: []string{""}, Resources: []string{"pods"}}), "", "pods", false, true},
		{"subresource rule is not the resource", rules(Rule{APIGroups: []string{""}, Resources: []string{"pods/exec"}}), "", "pods", true, false},
		{"named exclusion", &Matching{ResourceRules: []Rule{{APIGroups: []string{"*"}, Resources: []string{"*"}}},
			ExcludeResourceRules: []Rule{ingress}}, "networking.k8s.io", "ingresses", false, false},
		{"wildcard exclusion keeps a candidate", &Matching{ResourceRules: []Rule{ingress},
			ExcludeResourceRules: []Rule{{APIGroups: []string{"*"}, Resources: []string{"*"}}}}, "networking.k8s.io", "ingresses", false, true},
	} {
		p := AdmissionPolicy{Spec: AdmissionSpec{MatchConstraints: tc.match}}
		if got := p.Targets(tc.group, tc.resource, tc.anyGroup); got != tc.want {
			t.Errorf("%s: Targets = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestCRDDetailsOnly(t *testing.T) {
	d := CRDDetails{
		Name:           "emqxes.apps.emqx.io",
		ServedVersions: []CRDServedVersion{{Name: "v2alpha1"}, {Name: "v2beta1", Storage: true}},
		Versions:       []CRDSchemaVersion{{Name: "v2alpha1"}, {Name: "v2beta1", Storage: true}},
	}
	for version, want := range map[string]string{"": "v2beta1", "v2alpha1": "v2alpha1"} {
		got, err := d.Only(version)
		if err != nil || len(got.Versions) != 1 || got.Versions[0].Name != want || len(got.ServedVersions) != 2 {
			t.Errorf("Only(%q) = %+v %v", version, got, err)
		}
	}
	if _, err := d.Only("v1"); err == nil || !strings.Contains(err.Error(), "served versions: v2alpha1, v2beta1") {
		t.Errorf("unserved version = %v", err)
	}
	// The storage version may no longer be served; the first served one stands in.
	d.Versions[1].Storage = false
	if got, err := d.Only(""); err != nil || got.Versions[0].Name != "v2alpha1" {
		t.Errorf("no served storage version = %+v %v", got, err)
	}
	if d.Versions[0].Name != "v2alpha1" || len(d.Versions) != 2 {
		t.Error("Only changed its receiver")
	}
}
