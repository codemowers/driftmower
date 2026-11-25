package dashboard

import (
	"context"
	"fmt"
	"reflect"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
)

// The cluster CA trust layer one-click install can add where Pods get no CA
// bundle, using the codemowers platform's own pieces and names: cert-manager,
// trust-manager, and a Bundle named trusted-ca-certs distributing the public
// CAs to every namespace as a ConfigMap with key ca.pem. Driftmower opts in
// with trustedCA.configMapName; other workloads can mount the same ConfigMap,
// and adopting the platform's workload-trusted-ca admission policy later
// makes the explicit setting redundant.
const (
	trustBundleName     = "trusted-ca-certs"
	trustBundleKey      = "ca.pem"
	certManagerChart    = "oci://quay.io/jetstack/charts/cert-manager"
	certManagerVersion  = "1.20.0"
	trustManagerChart   = "oci://quay.io/jetstack/charts/trust-manager"
	trustManagerVersion = "0.22.0"
	trustNamespace      = "cert-manager"
)

var bundleResource = schema.GroupVersionResource{Group: "trust.cert-manager.io", Version: "v1alpha1", Resource: "bundles"}

// TrustSetup reports which parts of the CA trust layer already exist and
// lists copyable commands for the missing ones.
type TrustSetup struct {
	CertManager  bool     `json:"certManager,omitempty"`
	TrustManager bool     `json:"trustManager,omitempty"`
	Bundle       bool     `json:"bundle,omitempty"`
	Commands     []string `json:"commands"`
}

func servesResource(client kubernetes.Interface, groupVersion, resource string) bool {
	list, err := client.Discovery().ServerResourcesForGroupVersion(groupVersion)
	if err != nil {
		return false
	}
	for _, r := range list.APIResources {
		if r.Name == resource {
			return true
		}
	}
	return false
}

func trustSetup(ctx context.Context, client kubernetes.Interface, kubeContext string) *TrustSetup {
	setup := &TrustSetup{
		// Never null in JSON, also when every part already exists.
		Commands:     []string{},
		CertManager:  servesResource(client, "cert-manager.io/v1", "certificates"),
		TrustManager: servesResource(client, bundleResource.GroupVersion().String(), bundleResource.Resource),
	}
	if setup.TrustManager {
		// The discovery REST client is absent in fake clientsets.
		if rest := client.Discovery().RESTClient(); rest != nil && !reflect.ValueOf(rest).IsNil() {
			setup.Bundle = rest.Get().AbsPath("/apis", bundleResource.Group, bundleResource.Version, bundleResource.Resource, trustBundleName).Do(ctx).Error() == nil
		}
	}
	context := shellQuote(kubeContext)
	if !setup.CertManager {
		setup.Commands = append(setup.Commands, "helm "+strings.Join(quoteAll(certManagerArgs("", kubeContext)), " "))
	}
	if !setup.TrustManager {
		setup.Commands = append(setup.Commands, "helm "+strings.Join(quoteAll(trustManagerArgs("", kubeContext)), " "))
	}
	if !setup.Bundle {
		setup.Commands = append(setup.Commands, fmt.Sprintf("kubectl --context %s apply -f - <<'EOF'\n%sEOF", context, bundleYAML))
	}
	return setup
}

func quoteAll(args []string) []string {
	out := make([]string, len(args))
	for i, arg := range args {
		out[i] = shellQuote(arg)
	}
	return out
}

func certManagerArgs(kubeconfig, kubeContext string) []string {
	args := []string{"upgrade", "--install", "cert-manager", certManagerChart, "--version", certManagerVersion}
	if kubeconfig != "" {
		args = append(args, "--kubeconfig", kubeconfig)
	}
	return append(args, "--kube-context", kubeContext, "--namespace", trustNamespace, "--create-namespace", "--set", "crds.enabled=true", "--set", "enableCertificateOwnerRef=true")
}

func trustManagerArgs(kubeconfig, kubeContext string) []string {
	args := []string{"upgrade", "--install", "trust-manager", trustManagerChart, "--version", trustManagerVersion}
	if kubeconfig != "" {
		args = append(args, "--kubeconfig", kubeconfig)
	}
	return append(args, "--kube-context", kubeContext, "--namespace", trustNamespace)
}

const bundleYAML = `apiVersion: trust.cert-manager.io/v1alpha1
kind: Bundle
metadata:
  name: trusted-ca-certs
spec:
  sources:
    - useDefaultCAs: true
  target:
    configMap:
      key: ca.pem
    namespaceSelector: {}
`

// createTrustBundle creates the platform-named Bundle unless it exists; an
// existing Bundle, possibly with internal CAs, is left as it is.
func createTrustBundle(ctx context.Context, kubeconfig string) error {
	config, err := clientcmd.BuildConfigFromFlags("", kubeconfig)
	if err != nil {
		return err
	}
	client, err := dynamic.NewForConfig(config)
	if err != nil {
		return err
	}
	bundle := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": bundleResource.GroupVersion().String(),
		"kind":       "Bundle",
		"metadata":   map[string]any{"name": trustBundleName},
		"spec": map[string]any{
			"sources": []any{map[string]any{"useDefaultCAs": true}},
			"target": map[string]any{
				"configMap":         map[string]any{"key": trustBundleKey},
				"namespaceSelector": map[string]any{},
			},
		},
	}}
	_, err = client.Resource(bundleResource).Create(ctx, bundle, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		return nil
	}
	return err
}
