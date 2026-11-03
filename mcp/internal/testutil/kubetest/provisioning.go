// Package kubetest builds fake clusters for tests.
package kubetest

import (
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	fakediscovery "k8s.io/client-go/discovery/fake"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

// Cluster is a fake cluster's typed and dynamic clients.
type Cluster struct {
	Kubernetes *fake.Clientset
	Dynamic    *dynamicfake.FakeDynamicClient
}

func gvr(group, version, resource string) schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: group, Version: version, Resource: resource}
}

func obj(apiVersion, kind string, fields map[string]any) *unstructured.Unstructured {
	fields["apiVersion"], fields["kind"] = apiVersion, kind

	return &unstructured.Unstructured{Object: fields}
}

func meta(name string, extra map[string]any) map[string]any {
	m := map[string]any{"name": name}
	for k, v := range extra {
		m[k] = v
	}

	return m
}

func ptr[T any](v T) *T { return &v }

// ProvisioningCluster is a small platform: CloudNativePG installed and
// healthy, one zone, a default storage class, an enforced tenant ingress guard
// with a parameter ConfigMap, an HTTP-01 cluster issuer, and two tenant
// namespaces labelled codemowers.io/tenant.
func ProvisioningCluster() *Cluster {
	k := fake.NewClientset(
		&corev1.Node{
			ObjectMeta: metav1.ObjectMeta{Name: "node-a", Labels: map[string]string{"topology.kubernetes.io/zone": "a", "node-role.kubernetes.io/control-plane": ""}},
			Status: corev1.NodeStatus{
				Conditions:  []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionTrue}},
				Allocatable: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("4"), corev1.ResourceMemory: resource.MustParse("8Gi")},
			},
		},
		&appsv1.Deployment{
			ObjectMeta: metav1.ObjectMeta{Name: "cnpg-cloudnative-pg", Namespace: "ops", Labels: map[string]string{"app.kubernetes.io/version": "1.24"}},
			Spec:       appsv1.DeploymentSpec{Replicas: ptr(int32(1))},
			Status:     appsv1.DeploymentStatus{ReadyReplicas: 1},
		},
		&corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "ingress-params", Namespace: "platform"}, Data: map[string]string{"ingressDomainSuffix": ".apps.example.com"}},
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "team-a", Labels: map[string]string{
			"kubernetes.io/metadata.name": "team-a", "codemowers.io/tenant": "acme", "pod-security.kubernetes.io/enforce": "restricted",
		}}},
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "team-b", Labels: map[string]string{"kubernetes.io/metadata.name": "team-b", "codemowers.io/tenant": "other"}}},
		&corev1.ResourceQuota{
			ObjectMeta: metav1.ObjectMeta{Name: "compute", Namespace: "team-a"},
			Status: corev1.ResourceQuotaStatus{
				Hard: corev1.ResourceList{"requests.cpu": resource.MustParse("2"), "requests.memory": resource.MustParse("4Gi")},
				Used: corev1.ResourceList{"requests.cpu": resource.MustParse("500m"), "requests.memory": resource.MustParse("1Gi")},
			},
		},
		&networkingv1.NetworkPolicy{
			ObjectMeta: metav1.ObjectMeta{Name: "default-deny", Namespace: "team-a"},
			Spec:       networkingv1.NetworkPolicySpec{PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress}},
		},
	)
	k.Discovery().(*fakediscovery.FakeDiscovery).Resources = []*metav1.APIResourceList{
		{GroupVersion: "v1", APIResources: []metav1.APIResource{
			{Name: "pods", Kind: "Pod", Namespaced: true, Verbs: []string{"list"}},
			{Name: "secrets", Kind: "Secret", Namespaced: true, Verbs: []string{"list"}},
			{Name: "pods/log", Kind: "Pod", Namespaced: true, Verbs: []string{"get"}},
		}},
		{GroupVersion: "apps/v1", APIResources: []metav1.APIResource{{Name: "deployments", Kind: "Deployment", Namespaced: true, Verbs: []string{"list"}}}},
		{GroupVersion: "postgresql.cnpg.io/v1", APIResources: []metav1.APIResource{{Name: "clusters", Kind: "Cluster", Namespaced: true, Verbs: []string{"list"}}}},
		{GroupVersion: "networking.k8s.io/v1", APIResources: []metav1.APIResource{
			{Name: "networkpolicies", Kind: "NetworkPolicy", Namespaced: true, Verbs: []string{"list"}},
			{Name: "ingresses", Kind: "Ingress", Namespaced: true, Verbs: []string{"list"}},
		}},
		{GroupVersion: "admissionregistration.k8s.io/v1", APIResources: []metav1.APIResource{
			{Name: "validatingadmissionpolicies", Kind: "ValidatingAdmissionPolicy", Verbs: []string{"list"}},
			{Name: "validatingadmissionpolicybindings", Kind: "ValidatingAdmissionPolicyBinding", Verbs: []string{"list"}},
		}},
		{GroupVersion: "cert-manager.io/v1", APIResources: []metav1.APIResource{{Name: "clusterissuers", Kind: "ClusterIssuer", Verbs: []string{"list"}}}},
	}

	listKinds := map[schema.GroupVersionResource]string{
		gvr("storage.k8s.io", "v1", "storageclasses"):                                  "StorageClassList",
		gvr("networking.k8s.io", "v1", "ingressclasses"):                               "IngressClassList",
		gvr("scheduling.k8s.io", "v1", "priorityclasses"):                              "PriorityClassList",
		gvr("cert-manager.io", "v1", "clusterissuers"):                                 "ClusterIssuerList",
		gvr("apiextensions.k8s.io", "v1", "customresourcedefinitions"):                 "CustomResourceDefinitionList",
		gvr("admissionregistration.k8s.io", "v1", "validatingadmissionpolicies"):       "ValidatingAdmissionPolicyList",
		gvr("admissionregistration.k8s.io", "v1", "validatingadmissionpolicybindings"): "ValidatingAdmissionPolicyBindingList",
		gvr("kyverno.io", "v1", "clusterpolicies"):                                     "ClusterPolicyList",
		gvr("cilium.io", "v2", "ciliumnetworkpolicies"):                                "CiliumNetworkPolicyList",
	}
	objects := []runtime.Object{
		obj("storage.k8s.io/v1", "StorageClass", map[string]any{
			"metadata":             meta("cephfs", map[string]any{"annotations": map[string]any{"storageclass.kubernetes.io/is-default-class": "true", "kubernetes.io/description": "Shared filesystem"}}),
			"provisioner":          "rook-ceph.cephfs.csi.ceph.com",
			"allowVolumeExpansion": true,
			"parameters":           map[string]any{"csi.storage.k8s.io/fstype": "ext4"},
		}),
		obj("storage.k8s.io/v1", "StorageClass", map[string]any{
			"metadata":          meta("local", nil),
			"provisioner":       "rancher.io/local-path",
			"volumeBindingMode": "WaitForFirstConsumer",
		}),
		obj("networking.k8s.io/v1", "IngressClass", map[string]any{
			"metadata": meta("shared", map[string]any{"annotations": map[string]any{"ingressclass.kubernetes.io/is-default-class": "true"}}),
			"spec":     map[string]any{"controller": "traefik.io/ingress-controller"},
		}),
		obj("scheduling.k8s.io/v1", "PriorityClass", map[string]any{"metadata": meta("high", nil), "value": int64(1000)}),
		obj("scheduling.k8s.io/v1", "PriorityClass", map[string]any{"metadata": meta("low", nil), "value": int64(10), "globalDefault": true}),
		obj("cert-manager.io/v1", "ClusterIssuer", map[string]any{
			"metadata": meta("letsencrypt", nil),
			"spec":     map[string]any{"acme": map[string]any{"solvers": []any{map[string]any{"http01": map[string]any{}}}}},
			"status":   map[string]any{"conditions": []any{map[string]any{"type": "Ready", "status": "True"}}},
		}),
		obj("apiextensions.k8s.io/v1", "CustomResourceDefinition", map[string]any{
			"metadata": meta("clusters.postgresql.cnpg.io", map[string]any{"annotations": map[string]any{"kubernetes.io/description": "PostgreSQL clusters"}}),
			"spec": map[string]any{
				"group": "postgresql.cnpg.io", "scope": "Namespaced",
				"names": map[string]any{"kind": "Cluster", "plural": "clusters"},
				"versions": []any{map[string]any{"name": "v1", "served": true, "storage": true, "schema": map[string]any{"openAPIV3Schema": map[string]any{
					"type":     "object",
					"required": []any{"spec", "status"},
					"properties": map[string]any{
						"spec":   map[string]any{"type": "object", "x-kubernetes-validations": []any{map[string]any{"rule": "self.x > 0"}}},
						"status": map[string]any{"type": "object"},
					},
				}}}},
			},
			"status": map[string]any{"conditions": []any{map[string]any{"type": "Established", "status": "True"}}},
		}),
		obj("apiextensions.k8s.io/v1", "CustomResourceDefinition", map[string]any{
			"metadata": meta("clusterissuers.cert-manager.io", nil),
			"spec": map[string]any{
				"group": "cert-manager.io", "scope": "Cluster",
				"names":    map[string]any{"kind": "ClusterIssuer", "plural": "clusterissuers"},
				"versions": []any{map[string]any{"name": "v1", "served": true, "storage": true}},
			},
			"status": map[string]any{"conditions": []any{map[string]any{"type": "Established", "status": "True"}}},
		}),
		obj("admissionregistration.k8s.io/v1", "ValidatingAdmissionPolicy", map[string]any{
			"metadata": meta("tenant-ingress-hosts", map[string]any{"annotations": map[string]any{"kubernetes.io/description": "Ingress hosts carry the tenant prefix"}}),
			"spec": map[string]any{
				"matchConstraints": map[string]any{"resourceRules": []any{map[string]any{
					"apiGroups": []any{"networking.k8s.io"}, "apiVersions": []any{"v1"}, "operations": []any{"CREATE", "UPDATE"}, "resources": []any{"ingresses"},
				}}},
				"variables": []any{map[string]any{"name": "tenant", "expression": "namespaceObject.metadata.labels['codemowers.io/tenant']"}},
				"validations": []any{map[string]any{
					"expression": "'platform-admins' in request.userInfo.groups || object.spec.rules.all(r, r.host.startsWith(variables.tenant))",
					"message":    "Ingress hosts must start with the tenant id.",
				}},
			},
		}),
		obj("admissionregistration.k8s.io/v1", "ValidatingAdmissionPolicyBinding", map[string]any{
			"metadata": meta("tenant-ingress-hosts", nil),
			"spec": map[string]any{
				"policyName": "tenant-ingress-hosts", "validationActions": []any{"Deny"},
				"paramRef": map[string]any{"name": "ingress-params", "namespace": "platform", "parameterNotFoundAction": "Deny"},
			},
		}),
	}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), listKinds, objects...)
	// Kyverno and Cilium are not installed.
	for _, absent := range []string{"clusterpolicies", "ciliumnetworkpolicies"} {
		dyn.PrependReactor("list", absent, func(a k8stesting.Action) (bool, runtime.Object, error) {
			return true, nil, apierrors.NewNotFound(a.GetResource().GroupResource(), "")
		})
	}

	return &Cluster{Kubernetes: k, Dynamic: dyn}
}
