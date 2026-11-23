package scanner

import (
	"context"
	"crypto/sha256"
	"fmt"
	"reflect"
	"slices"
	"strings"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/utils/ptr"
)

const StrategyWorkloadNamespace = "workloadNamespace"
const StrategyOperatorNamespace = "operatorNamespace"
const scannerOwnerLabel = "driftmower.io/scanner-owner"

func (c *Controller) scanNamespace() string {
	if c.Config.Strategy == StrategyWorkloadNamespace {
		return ""
	}
	return c.Config.Namespace
}
func (c *Controller) attemptNamespace(a scanAttempt) string {
	if a.Namespace != "" {
		return a.Namespace
	}
	return c.Config.Namespace
}
func (c *Controller) scannerOwner() string { return Key(c.Config.Namespace, c.Config.Instance)[:40] }

// Match observed immutable identity, never a tag which may have moved. Kubelets
// may report the platform manifest, parent index, or config digest in ImageID.
func consumingPod(pod *corev1.Pod, image *unstructured.Unstructured, digest string) bool {
	if pod.DeletionTimestamp != nil || pod.Status.Phase != corev1.PodRunning || pod.Spec.NodeName == "" || pod.Labels["driftmower-scan"] == "driftmower-scan" {
		return false
	}
	identities := []string{digest}
	manifests, _, _ := unstructured.NestedSlice(image.Object, "manifests")
	for _, raw := range manifests {
		m, ok := raw.(map[string]any)
		if !ok || m["digest"] != digest {
			continue
		}
		if config, ok := m["configDigest"].(string); ok && config != "" {
			identities = append(identities, config)
		}
	}
	index, _, _ := unstructured.NestedString(image.Object, "index", "digest")
	if index != "" {
		identities = append(identities, index)
	}
	statuses := append(slices.Clone(pod.Status.ContainerStatuses), pod.Status.InitContainerStatuses...)
	statuses = append(statuses, pod.Status.EphemeralContainerStatuses...)
	for _, s := range statuses {
		id := strings.TrimPrefix(strings.TrimPrefix(s.ImageID, "docker-pullable://"), "containerd://")
		if _, d, ok := strings.Cut(id, "@"); ok {
			id = d
		}
		if slices.Contains(identities, id) {
			return true
		}
	}
	return false
}

func (c *Controller) nextAttempt(image *unstructured.Unstructured, state scanState, nodes []corev1.Node, arch, digest, key string, consumers []corev1.Pod) (scanAttempt, bool) {
	if c.Config.Strategy != StrategyWorkloadNamespace {
		return c.nextNode(image, state, nodes, arch, digest, key)
	}
	// Restrict placement to Nodes with an observed consumer. nextNode still
	// enforces readiness, architecture, hostname uniqueness and the retry budget.
	candidates := make([]corev1.Node, 0, len(nodes))
	sources := map[string]*corev1.Pod{}
	for i := range consumers {
		p := &consumers[i]
		if !consumingPod(p, image, digest) {
			continue
		}
		prior := sources[p.Spec.NodeName]
		if prior == nil || p.Namespace+"/"+p.Name < prior.Namespace+"/"+prior.Name {
			sources[p.Spec.NodeName] = p
		}
	}
	refs, _, _ := unstructured.NestedStringSlice(image.Object, "repoDigests")
	manifests, _, _ := unstructured.NestedSlice(image.Object, "manifests")
	ref, err := cachedReference(refs, manifests, arch, digest)
	if err != nil {
		return scanAttempt{}, false
	}
	for _, node := range nodes {
		if sources[node.Name] == nil {
			continue
		}
		// The consumer establishes local presence even when Node.status.images is capped.
		node.Status.Images = []corev1.ContainerImage{{Names: []string{ref}}}
		candidates = append(candidates, node)
	}
	a, ok := c.nextNode(image, state, candidates, arch, digest, key)
	if !ok {
		return a, false
	}
	source := sources[a.Node]
	a.Namespace, a.SourcePod, a.SourceUID = source.Namespace, source.Name, source.UID
	return a, true
}

func (c *Controller) prepareWorkloadScan(ctx context.Context, image *unstructured.Unstructured, digest string, a scanAttempt) ([]string, error) {
	source, err := c.Kube.CoreV1().Pods(a.Namespace).Get(ctx, a.SourcePod, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	if source.UID != a.SourceUID || source.Spec.NodeName != a.Node || !consumingPod(source, image, digest) {
		return nil, fmt.Errorf("consuming Pod changed before scan dispatch")
	}
	accounts := c.Kube.CoreV1().ServiceAccounts(a.Namespace)
	account, err := accounts.Get(ctx, c.Config.scanServiceAccount(), metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		account, err = accounts.Create(ctx, &corev1.ServiceAccount{ObjectMeta: metav1.ObjectMeta{Name: c.Config.scanServiceAccount(), Labels: map[string]string{scannerOwnerLabel: c.scannerOwner()}}, AutomountServiceAccountToken: ptr.To(false)}, metav1.CreateOptions{})
	}
	if err != nil {
		return nil, err
	}
	if a.Namespace != c.Config.Namespace && account.Labels[scannerOwnerLabel] != c.scannerOwner() {
		return nil, fmt.Errorf("scan ServiceAccount belongs to another owner")
	}
	secrets := make([]string, 0, len(source.Spec.ImagePullSecrets)+len(c.Config.PullSecrets))
	for _, s := range source.Spec.ImagePullSecrets {
		if !slices.Contains(secrets, s.Name) {
			secrets = append(secrets, s.Name)
		}
	}
	// Only configured infrastructure credentials cross namespaces. Workload
	// credentials remain references to their existing local Secrets.
	for _, name := range c.Config.PullSecrets {
		if a.Namespace == c.Config.Namespace {
			if !slices.Contains(secrets, name) {
				secrets = append(secrets, name)
			}
			continue
		}
		original, err := c.Kube.CoreV1().Secrets(c.Config.Namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return nil, err
		}
		if original.Type != corev1.SecretTypeDockerConfigJson && original.Type != corev1.SecretTypeDockercfg {
			return nil, fmt.Errorf("scanner pull Secret %s is not a Docker credential", name)
		}
		sum := sha256.Sum256([]byte(c.Config.Namespace + "/" + c.Config.Instance + "/" + name))
		copyName := fmt.Sprintf("scan-pull-%x", sum[:20])
		client := c.Kube.CoreV1().Secrets(a.Namespace)
		desired := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: copyName, Labels: map[string]string{scannerOwnerLabel: c.scannerOwner()}, OwnerReferences: []metav1.OwnerReference{{APIVersion: "v1", Kind: "ServiceAccount", Name: account.Name, UID: account.UID}}}, Type: original.Type, Data: original.Data}
		existing, err := client.Get(ctx, copyName, metav1.GetOptions{})
		if apierrors.IsNotFound(err) {
			_, err = client.Create(ctx, desired, metav1.CreateOptions{})
		} else if err == nil {
			if existing.Labels[scannerOwnerLabel] != c.scannerOwner() || !slices.ContainsFunc(existing.OwnerReferences, func(o metav1.OwnerReference) bool { return o.Kind == "ServiceAccount" && o.UID == account.UID }) {
				return nil, fmt.Errorf("scanner pull Secret belongs to another owner")
			}
			if existing.Type != desired.Type || !reflect.DeepEqual(existing.Data, desired.Data) {
				desired.ResourceVersion = existing.ResourceVersion
				_, err = client.Update(ctx, desired, metav1.UpdateOptions{})
			}
		}
		if err != nil {
			return nil, err
		}
		if !slices.Contains(secrets, copyName) {
			secrets = append(secrets, copyName)
		}
	}
	// Namespace default-deny policies must still allow DNS and uploads.
	policies := c.Kube.NetworkingV1().NetworkPolicies(a.Namespace)
	policy, err := policies.Get(ctx, c.Config.scanServiceAccount(), metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		_, err = policies.Create(ctx, &networkingv1.NetworkPolicy{
			ObjectMeta: metav1.ObjectMeta{Name: c.Config.scanServiceAccount(), Labels: map[string]string{scannerOwnerLabel: c.scannerOwner()}, OwnerReferences: []metav1.OwnerReference{{APIVersion: "v1", Kind: "ServiceAccount", Name: account.Name, UID: account.UID}}},
			Spec: networkingv1.NetworkPolicySpec{
				PodSelector: metav1.LabelSelector{MatchLabels: map[string]string{"app": c.Config.scanServiceAccount(), scannerOwnerLabel: c.scannerOwner()}},
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
				Egress: []networkingv1.NetworkPolicyEgressRule{
					{Ports: []networkingv1.NetworkPolicyPort{{Protocol: ptr.To(corev1.ProtocolUDP), Port: ptr.To(intstr.FromInt32(53))}, {Protocol: ptr.To(corev1.ProtocolTCP), Port: ptr.To(intstr.FromInt32(53))}}},
					{To: []networkingv1.NetworkPolicyPeer{{NamespaceSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"kubernetes.io/metadata.name": c.Config.Namespace}}, PodSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": c.Config.Instance + "-operator"}}}}, Ports: []networkingv1.NetworkPolicyPort{{Protocol: ptr.To(corev1.ProtocolTCP), Port: ptr.To(intstr.FromInt32(8080))}}},
				},
			},
		}, metav1.CreateOptions{})
	} else if err == nil && (policy.Labels[scannerOwnerLabel] != c.scannerOwner() || !slices.ContainsFunc(policy.OwnerReferences, func(o metav1.OwnerReference) bool { return o.Kind == "ServiceAccount" && o.UID == account.UID })) {
		return nil, fmt.Errorf("scan NetworkPolicy belongs to another owner")
	}
	if err != nil {
		return nil, err
	}
	return secrets, nil
}
