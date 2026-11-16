package mcpserver

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
)

func testCA(t *testing.T, name string, notAfter time.Time) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(42), Subject: pkix.Name{CommonName: name}, NotBefore: notAfter.Add(-48 * time.Hour), NotAfter: notAfter, IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

func TestCollectTrustBundles(t *testing.T) {
	now := time.Date(2026, 11, 11, 0, 0, 0, 0, time.UTC)
	bundle := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "trust.cert-manager.io/v1alpha1", "kind": "Bundle", "metadata": map[string]any{"name": "trusted-ca-certs"},
		"spec": map[string]any{
			"sources": []any{map[string]any{"useDefaultCAs": true}, map[string]any{"secret": map[string]any{"name": "root-ca", "key": "ca.crt"}}},
			"target":  map[string]any{"configMap": map[string]any{"key": "ca.pem"}},
		},
		"status": map[string]any{"conditions": []any{map[string]any{"type": "Synced", "status": "True", "reason": "Synced"}}},
	}}
	undistributed := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "trust.cert-manager.io/v1alpha1", "kind": "Bundle", "metadata": map[string]any{"name": "elsewhere"},
		"spec": map[string]any{"target": map[string]any{"configMap": map[string]any{"key": "ca.crt"}}},
	}}
	cm := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "ConfigMap", "metadata": map[string]any{"name": "trusted-ca-certs", "namespace": "driftmower"},
		"data": map[string]any{"ca.pem": testCA(t, "Internal Root", now.Add(time.Hour)) + testCA(t, "Old Root", now.Add(-time.Hour))},
	}}
	policy := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "admissionregistration.k8s.io/v1", "kind": "MutatingAdmissionPolicy",
		"metadata": map[string]any{"name": "workload-trusted-ca", "annotations": map[string]any{"kubernetes.io/description": "Mounts the bundle."}},
		"spec":     map[string]any{"mutations": []any{map[string]any{"jsonPatch": map[string]any{"expression": "{'configMap': dyn({'name': dyn('trusted-ca-certs')})}"}}}},
	}}
	other := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "admissionregistration.k8s.io/v1", "kind": "MutatingAdmissionPolicy", "metadata": map[string]any{"name": "unrelated"},
		"spec": map[string]any{"mutations": []any{map[string]any{"jsonPatch": map[string]any{"expression": "'trusted-ca-certs-old'"}}}},
	}}
	client := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{
		trustBundlesGVR: "BundleList", mutatingAdmissionPoliciesGVR: "MutatingAdmissionPolicyList",
	}, bundle, undistributed, cm, policy, other)

	out := collectTrustBundles(context.Background(), client, "driftmower", now)
	if len(out.Bundles) != 2 || out.Bundles[1].Name != "trusted-ca-certs" {
		t.Fatalf("bundles = %+v", out.Bundles)
	}
	b := out.Bundles[1]
	if !b.Synced || b.ConfigMapKey != "ca.pem" || len(b.Sources) != 2 || b.Sources[0].Kind != "defaultCAs" || b.Sources[1].Name != "root-ca" {
		t.Errorf("bundle = %+v", b)
	}
	if len(b.Certificates) != 2 || b.Certificates[0].Subject != "CN=Internal Root" || !b.Certificates[0].IsCA || !b.Certificates[0].SelfSigned || b.Certificates[0].Expired || !b.Certificates[1].Expired || len(b.Certificates[0].SHA256) != 64 {
		t.Errorf("certificates = %+v", b.Certificates)
	}
	if len(b.MountedBy) != 1 || b.MountedBy[0].Policy != "workload-trusted-ca" || b.MountedBy[0].Description != "Mounts the bundle." {
		t.Errorf("mountedBy = %+v", b.MountedBy)
	}
	if len(out.Warnings) != 1 || len(out.Bundles[0].Certificates) != 0 {
		t.Errorf("warnings = %v", out.Warnings)
	}
}
