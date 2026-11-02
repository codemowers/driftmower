package workloads

import (
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const maxDepth = 32

var cnpgCertificateFields = []string{"serverTLSSecret", "serverCASecret", "clientCASecret", "replicationTLSSecret"}

// inTreeSecretPlugins are volume plugins that still carry local Secret
// references.
var inTreeSecretPlugins = []string{"azureFile", "cephfs", "cinder", "flexVolume", "iscsi", "rbd", "scaleIO", "storageos"}

var ordinal = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)

// controllerOwner returns the controlling owner reference, or the only
// reference when it does not say whether it controls.
func controllerOwner(obj *Object) *metav1.OwnerReference {
	for i := range obj.Owners {
		if ref := &obj.Owners[i]; ref.Controller != nil && *ref.Controller {
			return ref
		}
	}
	if len(obj.Owners) == 1 && obj.Owners[0].Controller == nil {
		return &obj.Owners[0]
	}
	return nil
}

func isController(kind, apiVersion string) bool {
	return slices.ContainsFunc(Sources, func(s *Source) bool {
		return s.Category == "" && s.Kind == kind && s.Group() == group(apiVersion)
	})
}

func isBuiltIn(kind, apiVersion string) bool {
	return slices.ContainsFunc(Sources, func(s *Source) bool { return s.Kind == kind && s.Group() == group(apiVersion) })
}

// matches reports whether obj is the object ref names, not a same-name
// replacement.
func matches(obj *Object, ref *metav1.OwnerReference) bool {
	return obj != nil && obj.Kind == ref.Kind && obj.Name == ref.Name && group(obj.APIVersion) == group(ref.APIVersion)
}

// podReferences extracts references only, never environment values,
// configuration data or credentials.
func podReferences(deps *Dependencies, spec map[string]any) {
	containers := append(append(array(spec["containers"]), array(spec["initContainers"])...), array(spec["ephemeralContainers"])...)
	for _, container := range containers {
		deps.add(Images, container["image"])
		for _, env := range array(container["env"]) {
			ref := record(env["valueFrom"])
			deps.add(ConfigMaps, record(ref["configMapKeyRef"])["name"])
			deps.add(Secrets, record(ref["secretKeyRef"])["name"])
		}
		for _, env := range array(container["envFrom"]) {
			deps.add(ConfigMaps, record(env["configMapRef"])["name"])
			deps.add(Secrets, record(env["secretRef"])["name"])
		}
	}
	for _, ref := range array(spec["imagePullSecrets"]) {
		deps.add(Secrets, ref["name"])
	}
	for _, volume := range array(spec["volumes"]) {
		deps.add(ConfigMaps, record(volume["configMap"])["name"])
		deps.add(Secrets, record(volume["secret"])["secretName"])
		deps.add(PVCs, record(volume["persistentVolumeClaim"])["claimName"])
		for _, ref := range array(record(volume["projected"])["sources"]) {
			deps.add(ConfigMaps, record(ref["configMap"])["name"])
			deps.add(Secrets, record(ref["secret"])["name"])
		}
		deps.add(Secrets, record(record(volume["csi"])["nodePublishSecretRef"])["name"])
		for _, plugin := range inTreeSecretPlugins {
			config := record(volume[plugin])
			deps.add(Secrets, config["secretName"])
			deps.add(Secrets, record(config["secretRef"])["name"])
		}
	}
}

func cnpgReferences(deps *Dependencies, spec map[string]any) {
	certificates := record(spec["certificates"])
	for _, field := range cnpgCertificateFields {
		deps.add(Secrets, certificates[field])
	}
	monitoring := record(spec["monitoring"])
	for _, query := range array(monitoring["customQueriesConfigMap"]) {
		deps.add(ConfigMaps, query["name"])
	}
	for _, query := range array(monitoring["customQueriesSecret"]) {
		deps.add(Secrets, query["name"])
	}
}

// omitFromOrphans skips shared controller outputs: they are dependencies when
// consumed, but unused copies and Helm's release bookkeeping are not orphaned
// application objects.
func omitFromOrphans(obj *Object) bool {
	if obj.Kind != "Secret" && obj.Kind != "ConfigMap" {
		return false
	}
	return (obj.Kind == "ConfigMap" && obj.Name == "kube-root-ca.crt") ||
		obj.Labels["trust.cert-manager.io/bundle"] != "" ||
		obj.Annotations["reflector.v1.k8s.emberstack.com/reflects"] != "" ||
		(obj.Kind == "Secret" && obj.Labels["owner"] == "helm" && strings.HasPrefix(obj.Name, "sh.helm.release.v1."))
}

// Inventory resolves the objects of one namespace into root workloads, the
// namespace bucket for unclaimed resources last among equals, sorted by kind,
// name and UID. Warnings name incomplete or unverified ancestry.
func Inventory(namespace string, lists []List, warnings map[string]bool) []*Workload {
	byUID := map[string]*Object{}
	for _, list := range lists {
		for _, obj := range list.Objects {
			byUID[obj.UID] = obj
		}
	}
	var order []*Object
	nodes := map[string]*Object{}
	addNode := func(obj *Object) {
		if _, ok := nodes[obj.UID]; !ok {
			order = append(order, obj)
		}
		nodes[obj.UID] = obj
	}
	for _, list := range lists {
		if list.Source.Category == "" {
			for _, obj := range list.Objects {
				addNode(obj)
			}
		}
	}

	// Custom owners need no additional reads: their verified child objects
	// supply UID, kind and name. Only workload controllers establish custom
	// roots; auxiliary objects join existing workloads or remain orphans.
	for _, list := range lists {
		for _, obj := range list.Objects {
			if list.Source.Category != "" || !isController(obj.Kind, obj.APIVersion) {
				continue
			}
			ref := controllerOwner(obj)
			if ref == nil || (ref.Kind == "Certificate" && group(ref.APIVersion) == "cert-manager.io") {
				continue
			}
			if !isBuiltIn(ref.Kind, ref.APIVersion) && byUID[string(ref.UID)] == nil {
				terminal := &Object{Kind: ref.Kind, APIVersion: ref.APIVersion, UID: string(ref.UID), Name: ref.Name, Namespace: namespace, OwnerReferenceOnly: true}
				addNode(terminal)
				byUID[terminal.UID] = terminal
			}
		}
	}

	var all []*Workload
	roots := map[string]*Workload{}
	rootByNode := map[string]*Workload{}
	labels := map[*Workload][]map[string]any{}
	for _, node := range order {
		root := node
		var chain []*Object
		seen := map[string]bool{}
		for controllerOwner(root) != nil && isController(root.Kind, root.APIVersion) {
			if len(chain) >= maxDepth {
				warnings[fmt.Sprintf("%s: ownership depth limit reached at %s/%s.", namespace, root.Kind, root.Name)] = true
				break
			}
			ref := controllerOwner(root)
			seen[root.UID] = true
			chain = append(chain, root)
			if seen[string(ref.UID)] {
				cycle := slices.Clone(chain[slices.IndexFunc(chain, func(o *Object) bool { return o.UID == string(ref.UID) }):])
				slices.SortFunc(cycle, func(a, b *Object) int { return strings.Compare(a.UID, b.UID) })
				root = cycle[0]
				warnings[fmt.Sprintf("%s: ownership cycle at %s/%s.", namespace, root.Kind, root.Name)] = true
				break
			}
			parent := byUID[string(ref.UID)]
			if !matches(parent, ref) {
				root = &Object{APIVersion: ref.APIVersion, Kind: ref.Kind, UID: string(ref.UID), Name: ref.Name, Namespace: namespace, OwnerReferenceOnly: true}
				warnings[fmt.Sprintf("%s: %s/%s is an owner reference only; its existence and further ancestry are unverified.", namespace, ref.Kind, ref.Name)] = true
				break
			}
			root = parent
		}

		workload := roots[root.UID]
		if workload == nil {
			workload = &Workload{Name: root.Name, Kind: root.Kind, Namespace: namespace, APIVersion: root.APIVersion, UID: root.UID, OwnerReferenceOnly: root.OwnerReferenceOnly}
			roots[root.UID] = workload
			all = append(all, workload)
		}
		rootByNode[node.UID] = workload

		template := record(node.Spec["template"])
		if node.Kind == "CronJob" {
			template = record(record(record(node.Spec["jobTemplate"])["spec"])["template"])
		}
		podSpec := record(template["spec"])
		if node.Kind == "Pod" {
			podSpec = record(node.Spec)
		}
		// Old ReplicaSet and Job templates may retain obsolete references:
		// use live Pods and the highest loaded controller template, not
		// revision history.
		direct := controllerOwner(node)
		useTemplate := root.UID == node.UID || (direct != nil && nodes[string(direct.UID)] == nil)
		if node.Kind == "Pod" || useTemplate {
			podReferences(&workload.Dependencies, podSpec)
		}
		if node.Kind == CNPGSource.Kind && node.APIVersion == CNPGSource.APIVersion {
			cnpgReferences(&workload.Dependencies, node.Spec)
		}
		if node.Kind == "StatefulSet" {
			workload.add(Services, node.Spec["serviceName"])
		}
		if node.Kind == "Pod" {
			workload.add(Pods, node.Name)
			for _, volume := range array(podSpec["volumes"]) {
				if name, ok := volume["name"].(string); ok && volume["ephemeral"] != nil {
					workload.add(PVCs, node.Name+"-"+name)
				}
			}
		}
		if node.Kind == "Pod" {
			labels[workload] = append(labels[workload], stringMap(node.Labels))
		} else if useTemplate {
			labels[workload] = append(labels[workload], record(record(template["metadata"])["labels"]))
		}
	}

	orphaned := &Workload{Name: "orphaned-workloads", Kind: "Namespace", Namespace: namespace, APIVersion: "v1", UID: "namespace:" + namespace}
	objectsOf := func(category Category) []*Object {
		var out []*Object
		for _, list := range lists {
			if list.Source.Category == category {
				out = append(out, list.Objects...)
			}
		}
		return out
	}

	services := objectsOf(Services)
	for _, service := range services {
		selector := record(service.Spec["selector"])
		if len(selector) == 0 {
			continue
		}
		for _, workload := range all {
			if slices.ContainsFunc(labels[workload], func(set map[string]any) bool {
				for key, value := range selector {
					if set[key] != value {
						return false
					}
				}
				return true
			}) {
				workload.add(Services, service.Name)
			}
		}
	}

	// Retained StatefulSet claims often have no ownerReference. Match only
	// observed PVC names against declared claim templates and ordinals.
	claims := objectsOf(PVCs)
	for _, node := range order {
		if node.Kind != "StatefulSet" {
			continue
		}
		workload := rootByNode[node.UID]
		for _, claimTemplate := range array(node.Spec["volumeClaimTemplates"]) {
			name, ok := record(claimTemplate["metadata"])["name"].(string)
			if !ok {
				continue
			}
			prefix := name + "-" + node.Name + "-"
			for _, claim := range claims {
				if rest, found := strings.CutPrefix(claim.Name, prefix); found && ordinal.MatchString(rest) {
					workload.add(PVCs, claim.Name)
				}
			}
		}
	}

	// Owned resources, such as StatefulSet PVCs, belong to the same root even
	// when no current Pod spec names them.
	var resourceOwners func(obj *Object, seen map[string]bool) []*Workload
	resourceOwners = func(obj *Object, seen map[string]bool) []*Workload {
		var owners []*Workload
		if seen[obj.UID] {
			return owners
		}
		if len(seen) >= maxDepth {
			warnings[namespace+": resource ownership depth limit reached."] = true
			return owners
		}
		seen[obj.UID] = true
		for i := range obj.Owners {
			ref := &obj.Owners[i]
			parent := byUID[string(ref.UID)]
			if !matches(parent, ref) {
				continue
			}
			if workload := rootByNode[string(ref.UID)]; workload != nil {
				owners = append(owners, workload)
			} else if workload := roots[string(ref.UID)]; workload != nil {
				owners = append(owners, workload)
			} else {
				owners = append(owners, resourceOwners(parent, maps.Clone(seen))...)
			}
		}
		return owners
	}
	for _, list := range lists {
		if list.Source.Category == "" {
			continue
		}
		for _, obj := range list.Objects {
			for _, workload := range resourceOwners(obj, map[string]bool{}) {
				workload.add(list.Source.Category, obj.Name)
			}
		}
	}

	// Give selectorless and unmatched Services to the namespace bucket before
	// associating Ingresses, so their routes and TLS references stay together.
	for _, service := range services {
		if !slices.ContainsFunc(all, func(w *Workload) bool { return w.has(Services, service.Name) }) {
			orphaned.add(Services, service.Name)
		}
	}
	withOrphans := append(slices.Clone(all), orphaned)

	for _, ingress := range objectsOf(Ingresses) {
		backends := []map[string]any{record(ingress.Spec["defaultBackend"])}
		for _, rule := range array(ingress.Spec["rules"]) {
			for _, path := range array(record(rule["http"])["paths"]) {
				backends = append(backends, record(path["backend"]))
			}
		}
		var targets []*Workload
		for _, workload := range withOrphans {
			if workload.has(Ingresses, ingress.Name) || slices.ContainsFunc(backends, func(backend map[string]any) bool {
				name, ok := record(backend["service"])["name"].(string)
				return ok && workload.has(Services, name)
			}) {
				targets = append(targets, workload)
			}
		}
		if len(targets) == 0 {
			targets = []*Workload{orphaned}
		}
		for _, workload := range targets {
			workload.add(Ingresses, ingress.Name)
			for _, tls := range array(ingress.Spec["tls"]) {
				workload.add(Secrets, tls["secretName"])
			}
		}
	}

	// Certificates are dependencies of workloads consuming their target
	// Secret, through Pod references or associated Ingress TLS alike.
	for _, certificate := range objectsOf(Certificates) {
		secretName, _ := certificate.Spec["secretName"].(string)
		if secretName == "" {
			continue
		}
		for _, workload := range withOrphans {
			if workload.has(Secrets, secretName) {
				workload.add(Certificates, certificate.Name)
			}
		}
	}

	for _, list := range lists {
		if list.Source.Category == "" {
			continue
		}
		for _, obj := range list.Objects {
			if !omitFromOrphans(obj) && !slices.ContainsFunc(withOrphans, func(w *Workload) bool { return w.has(list.Source.Category, obj.Name) }) {
				orphaned.add(list.Source.Category, obj.Name)
			}
		}
	}

	// A Pod without a controller, and a Certificate reached as an owner, are
	// unclaimed namespace objects.
	for index := len(withOrphans) - 1; index >= 0; index-- {
		workload := withOrphans[index]
		certificate := workload.Kind == "Certificate" && group(workload.APIVersion) == "cert-manager.io"
		if workload.Kind != "Pod" && !certificate {
			continue
		}
		// Static mirror Pods are not offered as standalone Pods.
		if pod := byUID[workload.UID]; workload.Kind == "Pod" && pod != nil && pod.Kind == "Pod" && len(pod.Owners) == 0 {
			if _, mirror := pod.Annotations["kubernetes.io/config.mirror"]; !mirror {
				orphaned.StandalonePods = append(orphaned.StandalonePods, StandalonePod{Name: workload.Name, UID: workload.UID})
			}
		}
		for _, category := range categories {
			for _, value := range *workload.field(category) {
				orphaned.add(category, value)
			}
		}
		withOrphans = slices.Delete(withOrphans, index, index+1)
	}
	slices.SortFunc(orphaned.StandalonePods, func(a, b StandalonePod) int { return strings.Compare(a.Name, b.Name) })

	// Keep generating-owner relationships within the namespace bucket.
	// Auxiliary custom owners never become roots or trigger more reads.
	for _, list := range lists {
		category := list.Source.Category
		if category == "" {
			continue
		}
		for _, obj := range list.Objects {
			if !orphaned.has(category, obj.Name) {
				continue
			}
			for i := range obj.Owners {
				ref := &obj.Owners[i]
				if isBuiltIn(ref.Kind, ref.APIVersion) {
					continue
				}
				qualified := ref.Kind
				if g := group(ref.APIVersion); g != "" {
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
				entry.add(category, obj.Name)
				entry.sort()
			}
		}
	}

	var out []*Workload
	for _, workload := range withOrphans {
		workload.sort()
		if workload != orphaned || !workload.empty() {
			out = append(out, workload)
		}
	}
	slices.SortStableFunc(out, func(a, b *Workload) int {
		return strings.Compare(a.Kind+"/"+a.Name+"/"+a.UID, b.Kind+"/"+b.Name+"/"+b.UID)
	})
	return out
}
