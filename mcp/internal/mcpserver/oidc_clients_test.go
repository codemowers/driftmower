package mcpserver

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/workloads"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
)

func TestOIDCClientApplicationsRespectCallerRBAC(t *testing.T) {
	client := func(ns, name, uri string, disabled bool) *unstructured.Unstructured {
		return &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "codemowers.cloud/v1", "kind": "OIDCClient",
			"metadata": map[string]any{"namespace": ns, "name": name, "annotations": map[string]any{"kubernetes.io/description": "Application description"}},
			"spec":     map[string]any{"displayName": "Agent operator", "uri": uri, "disabled": disabled, "displayOrder": int64(2), "allowedGroups": []any{"developers"}, "redirectUris": []any{"private-redirect"}, "secretMetadata": map[string]any{"private": "do-not-expose"}},
		}}
	}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{oidcClientsGVR: "OIDCClientList"},
		client("apps", "agent", "https://dashboard.example.com/", false),
		client("apps", "disabled", "https://disabled.example.com/", true),
		client("apps", "native", "myapp://launch", false),
		client("private", "secret", "https://private.example.com/", false))
	kube := fake.NewClientset()
	judge := &recordingJudge{answer: func(id authz.Identity, a authz.Attributes) authz.Verdict {
		if id.User == "alice" && a.Namespace == "apps" && a.Group == "codemowers.cloud" && a.Resource == "oidcclients" && a.Verb == "list" {
			return authz.Yes
		}
		return authz.No
	}}
	w := &Workloads{Judge: judge, Cache: &workloads.Cache{Dynamic: dyn, Kubernetes: kube, Scope: &authz.ScopeResolver{ListNamespaces: func(context.Context) ([]string, error) { return []string{"apps", "private"}, nil }}}}
	out, err := collectOIDCClients(context.Background(), w, authz.Identity{User: "alice"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(out.OIDCClients) != 1 || out.OIDCClients[0].Name != "Agent operator" || out.OIDCClients[0].URL != "https://dashboard.example.com/" || out.OIDCClients[0].Groups[0] != "developers" {
		t.Fatalf("unexpected applications: %+v", out)
	}
	body, _ := json.Marshal(out)
	for _, private := range []string{"private-redirect", "do-not-expose", "private.example.com"} {
		if strings.Contains(string(body), private) {
			t.Fatalf("private field leaked: %s", private)
		}
	}
	for _, action := range dyn.Actions() {
		if action.GetNamespace() != "apps" {
			t.Fatal("read namespace without caller permission", action)
		}
	}
	denied, err := collectOIDCClients(context.Background(), w, authz.Identity{User: "bob"}, "apps")
	if err != nil || len(denied.OIDCClients) != 0 || len(denied.Warnings) == 0 {
		t.Fatalf("denied caller: %+v %v", denied, err)
	}
}

func TestOIDCClientIngressReferenceRequiresCallerRead(t *testing.T) {
	obj := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "codemowers.cloud/v1", "kind": "OIDCClient", "metadata": map[string]any{"namespace": "apps", "name": "agent"}, "spec": map[string]any{"ingressRef": map[string]any{"name": "agent"}}}}
	ing := &networkingv1.Ingress{ObjectMeta: metav1.ObjectMeta{Namespace: "apps", Name: "agent"}, Spec: networkingv1.IngressSpec{Rules: []networkingv1.IngressRule{{Host: "dashboard.example.com", IngressRuleValue: networkingv1.IngressRuleValue{HTTP: &networkingv1.HTTPIngressRuleValue{Paths: []networkingv1.HTTPIngressPath{{Path: "/"}, {Path: "/api"}, {Path: "/auth/callback"}}}}}}}}
	for _, allowIngress := range []bool{false, true} {
		kube := fake.NewClientset(ing, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "apps"}})
		judge := &recordingJudge{answer: func(_ authz.Identity, a authz.Attributes) authz.Verdict {
			if a.Resource == "oidcclients" || (allowIngress && a.Resource == "ingresses" && a.Name == "agent" && a.Verb == "get") {
				return authz.Yes
			}
			return authz.No
		}}
		w := &Workloads{Judge: judge, Cache: &workloads.Cache{Kubernetes: kube, Dynamic: dynamicfake.NewSimpleDynamicClient(runtime.NewScheme(), obj)}}
		out, err := collectOIDCClients(context.Background(), w, authz.Identity{}, "apps")
		if err != nil {
			t.Fatal(err)
		}
		if allowIngress {
			if len(out.OIDCClients) != 1 || out.OIDCClients[0].URL != "https://dashboard.example.com/" {
				t.Fatalf("one application per registration: %+v", out)
			}
		} else if len(out.OIDCClients) != 0 || len(out.Warnings) == 0 || len(kube.Actions()) != 0 {
			t.Fatalf("Ingress read was not protected: %+v", out)
		}
	}
}
