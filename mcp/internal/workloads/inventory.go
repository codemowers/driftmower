package workloads

import (
	"regexp"
	"slices"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// SourceItems are one source's cached objects in a namespace.
type SourceItems struct {
	Source Source
	Items  []*Node
}

// owner is the controlling owner reference, or the only one when it does not
// say either way.
func owner(n *Node) *metav1.OwnerReference {
	refs := n.OwnerReferences
	for i := range refs {
		if refs[i].Controller != nil && *refs[i].Controller {
			return &refs[i]
		}
	}
	if len(refs) == 1 && refs[0].Controller == nil {
		return &refs[0]
	}

	return nil
}

func builtIn(kind, apiVersion string, controllersOnly bool) bool {
	for _, s := range Sources {
		if (!controllersOnly || s.Category == "") && s.Kind == kind && s.GVR.Group == groupOf(apiVersion) {
			return true
		}
	}

	return false
}

// isController reports whether a node is a built-in workload controller, the
// only kind whose ancestry is followed.
func isController(n *Node) bool {
	return builtIn(n.Kind, n.APIVersion, true)
}

func matches(parent *Node, ref *metav1.OwnerReference) bool {
	return parent != nil && parent.Kind == ref.Kind && parent.Name == ref.Name && groupOf(parent.APIVersion) == groupOf(ref.APIVersion)
}

func terminal(ref *metav1.OwnerReference, namespace string) *Node {
	return &Node{
		ObjectMeta:         metav1.ObjectMeta{UID: ref.UID, Name: ref.Name, Namespace: namespace},
		APIVersion:         ref.APIVersion,
		Kind:               ref.Kind,
		OwnerReferenceOnly: true,
	}
}

// Shared controller outputs are dependencies when consumed, but unused copies
// and Helm's release bookkeeping do not represent orphaned application objects.
func omitFromOrphans(n *Node) bool {
	if n.Kind != "Secret" && n.Kind != "ConfigMap" {
		return false
	}

	return (n.Kind == "ConfigMap" && n.Name == "kube-root-ca.crt") ||
		n.Labels["trust.cert-manager.io/bundle"] != "" ||
		n.Annotations["reflector.v1.k8s.emberstack.com/reflects"] != "" ||
		(n.Kind == "Secret" && n.Labels["owner"] == "helm" && strings.HasPrefix(n.Name, "sh.helm.release.v1."))
}

var ordinal = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)

const maxOwnershipDepth = 32

// BuildInventory resolves a namespace's objects into root workloads plus an
// orphan bucket. Warnings collect into warnings.
func BuildInventory(namespace string, lists []SourceItems, warnings map[string]bool) []*Workload {
	byUID := map[string]*Node{}
	for _, l := range lists {
		for _, n := range l.Items {
			byUID[string(n.UID)] = n
		}
	}

	// Workload graph nodes, in a stable order.
	var nodes []*Node
	inNodes := map[string]bool{}
	addNode := func(n *Node) {
		if !inNodes[string(n.UID)] {
			inNodes[string(n.UID)] = true
			nodes = append(nodes, n)
		}
	}
	for _, l := range lists {
		if l.Source.Category == "" {
			for _, n := range l.Items {
				addNode(n)
			}
		}
	}
	// Custom owners need no additional reads: their verified children supply
	// UID, kind and name. Only workload controllers establish custom roots.
	for _, l := range lists {
		if l.Source.Category != "" {
			continue
		}
		for _, n := range l.Items {
			ref := owner(n)
			if !isController(n) || ref == nil {
				continue
			}
			if ref.Kind == "Certificate" && groupOf(ref.APIVersion) == "cert-manager.io" {
				continue
			}
			if !builtIn(ref.Kind, ref.APIVersion, false) && byUID[string(ref.UID)] == nil {
				t := terminal(ref, namespace)
				addNode(t)
				byUID[string(ref.UID)] = t
			}
		}
	}

	var all []*Workload
	roots := map[string]*Workload{}
	rootByNode := map[string]*Workload{}
	labelSets := map[*Workload][]map[string]string{}

	for _, node := range nodes {
		root := node
		var chain []*Node
		seen := map[string]bool{}
		for owner(root) != nil && isController(root) {
			if len(chain) >= maxOwnershipDepth {
				warnings[namespace+": ownership depth limit reached at "+root.Kind+"/"+root.Name+"."] = true

				break
			}
			ref := owner(root)
			seen[string(root.UID)] = true
			chain = append(chain, root)
			if seen[string(ref.UID)] {
				i := slices.IndexFunc(chain, func(n *Node) bool { return n.UID == ref.UID })
				cycle := slices.Clone(chain[i:])
				slices.SortFunc(cycle, func(a, b *Node) int { return strings.Compare(string(a.UID), string(b.UID)) })
				root = cycle[0]
				warnings[namespace+": ownership cycle at "+root.Kind+"/"+root.Name+"."] = true

				break
			}
			parent := byUID[string(ref.UID)]
			if !matches(parent, ref) {
				root = terminal(ref, namespace)
				warnings[namespace+": "+ref.Kind+"/"+ref.Name+" is an owner reference only; its existence and further ancestry are unverified."] = true

				break
			}
			root = parent
		}

		w := roots[string(root.UID)]
		if w == nil {
			w = &Workload{Name: root.Name, Kind: root.Kind, Namespace: namespace, APIVersion: root.APIVersion, UID: string(root.UID),
				OwnerReferenceOnly: root.OwnerReferenceOnly}
			roots[string(root.UID)] = w
			all = append(all, w)
		}
		rootByNode[string(node.UID)] = w

		// Old ReplicaSet and Job templates may keep obsolete references. Use
		// live pods and the highest loaded controller template, not history.
		direct := owner(node)
		useTemplate := root.UID == node.UID || (direct != nil && !inNodes[string(direct.UID)])
		isPod := node.Kind == "Pod"
		if p := node.Spec.Pod; p != nil && (isPod || useTemplate) {
			for _, v := range p.Images {
				w.add(Images, v)
			}
			for _, v := range p.ConfigMaps {
				w.add(ConfigMaps, v)
			}
			for _, v := range p.Secrets {
				w.add(Secrets, v)
			}
			for _, v := range p.PVCs {
				w.add(PVCs, v)
			}
		}
		if node.Kind == CNPGSource.Kind && node.APIVersion == CNPGSource.APIVersion() {
			for _, v := range node.Spec.ReferencedSecrets {
				w.add(Secrets, v)
			}
			for _, v := range node.Spec.ReferencedConfigMaps {
				w.add(ConfigMaps, v)
			}
		}
		if node.Kind == "StatefulSet" {
			w.add(Services, node.Spec.ServiceName)
		}
		if isPod {
			w.add(Pods, node.Name)
			if node.Spec.Pod != nil {
				for _, v := range node.Spec.Pod.EphemeralVolumes {
					w.add(PVCs, node.Name+"-"+v)
				}
			}
		}
		if isPod {
			labelSets[w] = append(labelSets[w], node.Labels)
		} else if useTemplate {
			labelSets[w] = append(labelSets[w], node.Spec.TemplateLabels)
		}
	}

	orphaned := &Workload{Name: "orphaned-workloads", Kind: "Namespace", Namespace: namespace, APIVersion: "v1", UID: "namespace:" + namespace}
	itemsOf := func(c Category) []*Node {
		var out []*Node
		for _, l := range lists {
			if l.Source.Category == c {
				out = append(out, l.Items...)
			}
		}

		return out
	}

	services := itemsOf(Services)
	for _, svc := range services {
		if len(svc.Spec.Selector) == 0 {
			continue
		}
		for _, w := range all {
			if slices.ContainsFunc(labelSets[w], func(labels map[string]string) bool {
				for k, v := range svc.Spec.Selector {
					if actual, ok := labels[k]; !ok || actual != v {
						return false
					}
				}

				return true
			}) {
				w.add(Services, svc.Name)
			}
		}
	}

	// Retained StatefulSet claims often have no ownerReference. Match only
	// observed PVC names against declared claim templates and ordinals.
	claims := itemsOf(PVCs)
	for _, node := range nodes {
		if node.Kind != "StatefulSet" {
			continue
		}
		w := rootByNode[string(node.UID)]
		for _, name := range node.Spec.ClaimTemplates {
			prefix := name + "-" + node.Name + "-"
			for _, c := range claims {
				if rest, ok := strings.CutPrefix(c.Name, prefix); ok && ordinal.MatchString(rest) {
					w.add(PVCs, c.Name)
				}
			}
		}
	}

	// Owned resources (e.g. StatefulSet PVCs) belong to the same root even
	// when their names are not in a current pod spec.
	var resourceOwners func(item *Node, seen map[string]bool) []*Workload
	resourceOwners = func(item *Node, seen map[string]bool) []*Workload {
		if seen[string(item.UID)] {
			return nil
		}
		if len(seen) >= maxOwnershipDepth {
			warnings[namespace+": resource ownership depth limit reached."] = true

			return nil
		}
		seen[string(item.UID)] = true
		var owners []*Workload
		for i := range item.OwnerReferences {
			ref := &item.OwnerReferences[i]
			parent := byUID[string(ref.UID)]
			if !matches(parent, ref) {
				continue
			}
			if w := rootByNode[string(ref.UID)]; w != nil {
				owners = append(owners, w)
			} else if w := roots[string(ref.UID)]; w != nil {
				owners = append(owners, w)
			} else {
				branch := make(map[string]bool, len(seen))
				for k := range seen {
					branch[k] = true
				}
				owners = append(owners, resourceOwners(parent, branch)...)
			}
		}

		return owners
	}
	for _, l := range lists {
		if l.Source.Category == "" {
			continue
		}
		for _, item := range l.Items {
			for _, w := range resourceOwners(item, map[string]bool{}) {
				w.add(l.Source.Category, item.Name)
			}
		}
	}

	// Selectorless or unmatched Services go to the namespace bucket before
	// Ingresses are associated, so routes and TLS references stay together.
	for _, svc := range services {
		if !slices.ContainsFunc(all, func(w *Workload) bool { return w.has(Services, svc.Name) }) {
			orphaned.add(Services, svc.Name)
		}
	}
	withOrphans := append(slices.Clone(all), orphaned)

	for _, ing := range itemsOf(Ingresses) {
		var targets []*Workload
		for _, w := range withOrphans {
			if w.has(Ingresses, ing.Name) || slices.ContainsFunc(ing.Spec.BackendServices, func(s string) bool { return w.has(Services, s) }) {
				targets = append(targets, w)
			}
		}
		if len(targets) == 0 {
			targets = []*Workload{orphaned}
		}
		for _, w := range targets {
			w.add(Ingresses, ing.Name)
			for _, s := range ing.Spec.TLSSecrets {
				w.add(Secrets, s)
			}
		}
	}

	// Certificates are dependencies of workloads consuming their target
	// Secret, through pod references or associated Ingress TLS.
	for _, cert := range itemsOf(Certificates) {
		if cert.Spec.SecretName == "" {
			continue
		}
		for _, w := range withOrphans {
			if w.has(Secrets, cert.Spec.SecretName) {
				w.add(Certificates, cert.Name)
			}
		}
	}

	for _, l := range lists {
		if l.Source.Category == "" {
			continue
		}
		for _, item := range l.Items {
			if !omitFromOrphans(item) && !slices.ContainsFunc(withOrphans, func(w *Workload) bool { return w.has(l.Source.Category, item.Name) }) {
				orphaned.add(l.Source.Category, item.Name)
			}
		}
	}

	// A Pod with no controller is an unclaimed namespace object.
	for i := len(withOrphans) - 1; i >= 0; i-- {
		w := withOrphans[i]
		if w.Kind != "Pod" && !(w.Kind == "Certificate" && groupOf(w.APIVersion) == "cert-manager.io") {
			continue
		}
		if pod := byUID[w.UID]; w.Kind == "Pod" && pod != nil && pod.Kind == "Pod" && len(pod.OwnerReferences) == 0 {
			if _, mirror := pod.Annotations["kubernetes.io/config.mirror"]; !mirror {
				orphaned.StandalonePods = append(orphaned.StandalonePods, StandalonePod{Name: w.Name, UID: w.UID})
			}
		}
		for _, c := range categories {
			for _, v := range *w.list(c) {
				orphaned.add(c, v)
			}
		}
		withOrphans = slices.Delete(withOrphans, i, i+1)
	}
	slices.SortFunc(orphaned.StandalonePods, func(a, b StandalonePod) int { return compareLocale(a.Name, b.Name) })

	// Keep generating-owner relationships within the orphan bucket. Auxiliary
	// custom owners never become roots or trigger additional reads.
	for _, l := range lists {
		c := l.Source.Category
		if c == "" {
			continue
		}
		for _, item := range l.Items {
			if !orphaned.has(c, item.Name) {
				continue
			}
			for i := range item.OwnerReferences {
				ref := &item.OwnerReferences[i]
				if builtIn(ref.Kind, ref.APIVersion, false) {
					continue
				}
				qualified := ref.Kind
				if g := groupOf(ref.APIVersion); g != "" {
					qualified += "." + g
				}
				if orphaned.Orphaned == nil {
					orphaned.Orphaned = map[string]map[string]*OrphanOwner{}
				}
				if orphaned.Orphaned[qualified] == nil {
					orphaned.Orphaned[qualified] = map[string]*OrphanOwner{}
				}
				entry := orphaned.Orphaned[qualified][ref.Name]
				if entry == nil {
					parent := byUID[string(ref.UID)]
					verified := matches(parent, ref) && !parent.OwnerReferenceOnly
					entry = &OrphanOwner{APIVersion: ref.APIVersion, UID: string(ref.UID), OwnerReferenceOnly: !verified}
					orphaned.Orphaned[qualified][ref.Name] = entry
				}
				entry.add(c, item.Name)
				entry.sort()
			}
		}
	}

	out := make([]*Workload, 0, len(withOrphans))
	for _, w := range withOrphans {
		w.sort()
		if w != orphaned || !w.empty() {
			out = append(out, w)
		}
	}
	slices.SortStableFunc(out, func(a, b *Workload) int {
		return compareLocale(a.Kind+"/"+a.Name+"/"+a.UID, b.Kind+"/"+b.Name+"/"+b.UID)
	})

	return out
}

// compareLocale orders case-insensitively first, approximating
// JavaScript's localeCompare.
func compareLocale(a, b string) int {
	if c := strings.Compare(strings.ToLower(a), strings.ToLower(b)); c != 0 {
		return c
	}

	return strings.Compare(a, b)
}
