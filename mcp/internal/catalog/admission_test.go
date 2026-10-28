package catalog

import (
	"context"
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
