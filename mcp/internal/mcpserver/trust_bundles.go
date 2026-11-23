package mcpserver

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
)

var (
	trustBundlesGVR              = schema.GroupVersionResource{Group: "trust.cert-manager.io", Version: "v1alpha1", Resource: "bundles"}
	configMapsGVR                = schema.GroupVersionResource{Version: "v1", Resource: "configmaps"}
	mutatingAdmissionPoliciesGVR = schema.GroupVersionResource{Group: "admissionregistration.k8s.io", Version: "v1", Resource: "mutatingadmissionpolicies"}
)

type trustSource struct {
	// configMap, secret, inLine or defaultCAs.
	Kind string `json:"kind"`
	Name string `json:"name,omitempty"`
	Key  string `json:"key,omitempty"`
}

type trustMount struct {
	Policy      string `json:"policy"`
	Description string `json:"description,omitempty"`
}

type trustBundle struct {
	Name         string             `json:"name"`
	ConfigMapKey string             `json:"configMapKey,omitempty"`
	SecretKey    string             `json:"secretKey,omitempty"`
	Synced       bool               `json:"synced"`
	Reason       string             `json:"reason,omitempty"`
	Sources      []trustSource      `json:"sources"`
	Namespace    string             `json:"namespace,omitempty"`
	Certificates []trustCertificate `json:"certificates"`
	MountedBy    []trustMount       `json:"mountedBy"`
}

type trustBundlesOutput struct {
	Bundles  []trustBundle `json:"bundles"`
	Warnings []string      `json:"warnings"`
}

// Trust anchors are public certificates, so the inventory is served to every
// authenticated caller without a per-caller RBAC check.
func addTrustBundlesTool(s *mcp.Server, w *Workloads, mapping auth.Mapping) {
	mcp.AddTool(s, &mcp.Tool{Name: "list_trust_bundles", Title: "List trusted CA bundles", Description: "trust-manager Bundles with sources, the mounting admission policies and each certificate's details and findings (weak keys, short serials, weak signatures, expiry).", InputSchema: inputSchema[struct{}](nil), Annotations: readOnly("List trusted CA bundles")}, func(ctx context.Context, req *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, trustBundlesOutput, error) {
		if _, err := callerIdentity(req, mapping); err != nil {
			return nil, trustBundlesOutput{}, err
		}
		return nil, collectTrustBundles(ctx, w.Cache.Dynamic, os.Getenv("POD_NAMESPACE"), time.Now()), nil
	})
}

func collectTrustBundles(ctx context.Context, client dynamic.Interface, namespace string, now time.Time) trustBundlesOutput {
	out := trustBundlesOutput{Bundles: []trustBundle{}, Warnings: []string{}}
	list, err := client.Resource(trustBundlesGVR).List(ctx, metav1.ListOptions{})
	if err != nil {
		out.Warnings = append(out.Warnings, "trust-manager Bundles are unavailable: "+err.Error())
		return out
	}
	policies, err := client.Resource(mutatingAdmissionPoliciesGVR).List(ctx, metav1.ListOptions{})
	if err != nil {
		out.Warnings = append(out.Warnings, "Mutating admission policies are unavailable; mounting policies are not shown.")
		policies = &unstructured.UnstructuredList{}
	}
	for _, item := range list.Items {
		b := trustBundle{Name: item.GetName(), Sources: bundleSources(item), Certificates: []trustCertificate{}, MountedBy: []trustMount{}}
		b.ConfigMapKey, _, _ = unstructured.NestedString(item.Object, "spec", "target", "configMap", "key")
		b.SecretKey, _, _ = unstructured.NestedString(item.Object, "spec", "target", "secret", "key")
		b.Synced, b.Reason = bundleSynced(item)
		b.MountedBy = mountingPolicies(policies.Items, b.Name)
		if b.ConfigMapKey != "" && namespace != "" {
			b.Namespace = namespace
			cm, err := client.Resource(configMapsGVR).Namespace(namespace).Get(ctx, b.Name, metav1.GetOptions{})
			if err != nil {
				out.Warnings = append(out.Warnings, b.Name+": not distributed to namespace "+namespace+"; certificates are not shown.")
			} else {
				pemData, _, _ := unstructured.NestedString(cm.Object, "data", b.ConfigMapKey)
				b.Certificates = parseCertificates([]byte(pemData), now)
			}
		}
		out.Bundles = append(out.Bundles, b)
	}
	slices.SortFunc(out.Bundles, func(a, b trustBundle) int { return strings.Compare(a.Name, b.Name) })
	return out
}

func bundleSources(item unstructured.Unstructured) []trustSource {
	raw, _, _ := unstructured.NestedSlice(item.Object, "spec", "sources")
	sources := []trustSource{}
	for _, r := range raw {
		m, ok := r.(map[string]any)
		if !ok {
			continue
		}
		for _, kind := range []string{"configMap", "secret"} {
			if ref, ok := m[kind].(map[string]any); ok {
				name, _ := ref["name"].(string)
				key, _ := ref["key"].(string)
				if name == "" {
					name = "selector"
				}
				sources = append(sources, trustSource{Kind: kind, Name: name, Key: key})
			}
		}
		if _, ok := m["inLine"].(string); ok {
			sources = append(sources, trustSource{Kind: "inLine"})
		}
		if v, _ := m["useDefaultCAs"].(bool); v {
			sources = append(sources, trustSource{Kind: "defaultCAs"})
		}
	}
	return sources
}

func bundleSynced(item unstructured.Unstructured) (bool, string) {
	conditions, _, _ := unstructured.NestedSlice(item.Object, "status", "conditions")
	for _, c := range conditions {
		m, _ := c.(map[string]any)
		if m["type"] == "Synced" {
			reason, _ := m["reason"].(string)
			return m["status"] == "True", reason
		}
	}
	return false, "Unknown"
}

// mountingPolicies names the mutating admission policies whose mutations
// reference the bundle's distributed ConfigMap by name.
func mountingPolicies(policies []unstructured.Unstructured, name string) []trustMount {
	mounts := []trustMount{}
	for _, p := range policies {
		mutations, _, _ := unstructured.NestedSlice(p.Object, "spec", "mutations")
		raw, err := json.Marshal(mutations)
		if err != nil {
			continue
		}
		text := string(raw)
		if !strings.Contains(text, "'"+name+"'") && !strings.Contains(text, `\"`+name+`\"`) {
			continue
		}
		mounts = append(mounts, trustMount{Policy: p.GetName(), Description: p.GetAnnotations()["kubernetes.io/description"]})
	}
	return mounts
}

func parseCertificates(data []byte, now time.Time) []trustCertificate {
	certs := []trustCertificate{}
	for {
		var block *pem.Block
		block, data = pem.Decode(data)
		if block == nil {
			break
		}
		if block.Type != "CERTIFICATE" {
			continue
		}
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			continue
		}
		certs = append(certs, describeCertificate(cert, now))
	}
	return certs
}
