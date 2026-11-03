package cluster

import (
	"context"
	"log/slog"
	"regexp"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

var dnsLabel = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

// Discover derives the identity from the default/kubelogin Ingress, which
// publishes the cluster's API through Passmower OIDC. Only a single,
// unambiguous DNS host identifies the public API; otherwise the configured
// identity is kept.
func Discover(ctx context.Context, client kubernetes.Interface, fallback Identity, oidcIssuer string, logger *slog.Logger) Identity {
	ingress, err := client.NetworkingV1().Ingresses("default").Get(ctx, "kubelogin", metav1.GetOptions{})
	if err != nil {
		if !apierrors.IsNotFound(err) {
			logger.Warn("Unable to discover default/kubelogin; retaining configured cluster identity", "error", err)
		}

		return fallback
	}

	hosts := map[string]bool{}
	for _, rule := range ingress.Spec.Rules {
		if rule.Host != "" {
			hosts[strings.ToLower(rule.Host)] = true
		}
	}
	var host string
	for h := range hosts {
		host = h
	}
	if len(hosts) != 1 || !validHost(host) {
		logger.Warn("default/kubelogin has no unambiguous DNS hostname; retaining configured cluster identity")

		return fallback
	}

	id := strings.TrimPrefix(host, "kube.")
	apiURL := "https://" + host
	identity := NewIdentity(&id, &apiURL, apiURL)
	identity.Authentication = AuthenticationPassmowerOIDC
	identity.OIDCIssuerURL = oidcIssuer

	return identity
}

func validHost(host string) bool {
	if len(host) > 253 {
		return false
	}
	for label := range strings.SplitSeq(host, ".") {
		if !dnsLabel.MatchString(label) {
			return false
		}
	}

	return true
}
