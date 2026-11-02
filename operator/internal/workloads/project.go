package workloads

import (
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// markerAnnotations are the only annotations kept; arbitrary annotations can
// hold secrets.
var markerAnnotations = []string{"kubernetes.io/config.mirror", "reflector.v1.k8s.emberstack.com/reflects"}

// Project reduces an object to what the inventory uses, for informer caches:
// no env values, commands, annotations other than markers, Secret data or
// arbitrary custom-resource specs are retained. Metadata-only objects keep
// no spec.
func Project(source *Source, obj *unstructured.Unstructured) *unstructured.Unstructured {
	metadata := map[string]any{"name": obj.GetName(), "uid": string(obj.GetUID()), "resourceVersion": obj.GetResourceVersion()}
	if ns := obj.GetNamespace(); ns != "" {
		metadata["namespace"] = ns
	}
	if labels := obj.GetLabels(); len(labels) > 0 {
		metadata["labels"] = stringMap(labels)
	}
	annotations := map[string]any{}
	for _, key := range markerAnnotations {
		if value, ok := obj.GetAnnotations()[key]; ok {
			annotations[key] = value
		}
	}
	if len(annotations) > 0 {
		metadata["annotations"] = annotations
	}
	if owners, found, _ := unstructured.NestedSlice(obj.Object, "metadata", "ownerReferences"); found {
		metadata["ownerReferences"] = owners
	}
	projected := map[string]any{"apiVersion": source.APIVersion, "kind": source.Kind, "metadata": metadata}
	if !source.MetadataOnly {
		spec, _ := obj.Object["spec"].(map[string]any)
		projected["spec"] = ProjectSpec(source.Kind, spec)
	}
	return &unstructured.Unstructured{Object: projected}
}

// ToObject converts a projected object for the inventory.
func ToObject(source *Source, obj *unstructured.Unstructured) *Object {
	spec, _ := obj.Object["spec"].(map[string]any)
	return &Object{
		APIVersion:  source.APIVersion,
		Kind:        source.Kind,
		UID:         string(obj.GetUID()),
		Name:        obj.GetName(),
		Namespace:   obj.GetNamespace(),
		Labels:      obj.GetLabels(),
		Annotations: obj.GetAnnotations(),
		Owners:      obj.GetOwnerReferences(),
		Spec:        spec,
	}
}

// ProjectSpec keeps the references of a spec: images, volume and environment
// sources, selectors, routes and, for CNPG Clusters, the explicit TLS and
// monitoring query references.
func ProjectSpec(kind string, spec map[string]any) map[string]any {
	template := func(value any) map[string]any {
		input := record(value)
		return map[string]any{
			"metadata": map[string]any{"labels": record(record(input["metadata"])["labels"])},
			"spec":     projectPod(record(input["spec"])),
		}
	}
	switch kind {
	case "Cluster":
		certificates := record(spec["certificates"])
		kept := map[string]any{}
		for _, field := range cnpgCertificateFields {
			if value, ok := certificates[field].(string); ok {
				kept[field] = value
			}
		}
		monitoring := record(spec["monitoring"])
		names := func(value any) []any {
			out := []any{}
			for _, query := range array(value) {
				if name, ok := query["name"].(string); ok {
					out = append(out, map[string]any{"name": name})
				}
			}
			return out
		}
		return map[string]any{
			"certificates": kept,
			"monitoring": map[string]any{
				"customQueriesConfigMap": names(monitoring["customQueriesConfigMap"]),
				"customQueriesSecret":    names(monitoring["customQueriesSecret"]),
			},
		}
	case "Certificate":
		return map[string]any{"secretName": spec["secretName"]}
	case "Pod":
		return projectPod(spec)
	case "Service":
		return map[string]any{"selector": record(spec["selector"])}
	case "Ingress":
		var rules []any
		for _, rule := range array(spec["rules"]) {
			var paths []any
			for _, path := range array(record(rule["http"])["paths"]) {
				paths = append(paths, map[string]any{"backend": map[string]any{"service": map[string]any{
					"name": record(record(path["backend"])["service"])["name"]}}})
			}
			rules = append(rules, map[string]any{"http": map[string]any{"paths": paths}})
		}
		var tls []any
		for _, entry := range array(spec["tls"]) {
			tls = append(tls, map[string]any{"secretName": entry["secretName"]})
		}
		return map[string]any{
			"defaultBackend": map[string]any{"service": map[string]any{"name": record(record(spec["defaultBackend"])["service"])["name"]}},
			"rules":          rules,
			"tls":            tls,
		}
	case "CronJob":
		return map[string]any{"jobTemplate": map[string]any{"spec": map[string]any{
			"template": template(record(record(spec["jobTemplate"])["spec"])["template"])}}}
	}
	out := map[string]any{"template": template(spec["template"])}
	if kind == "StatefulSet" {
		out["serviceName"] = spec["serviceName"]
		var claims []any
		for _, claim := range array(spec["volumeClaimTemplates"]) {
			claims = append(claims, map[string]any{"metadata": map[string]any{"name": record(claim["metadata"])["name"]}})
		}
		out["volumeClaimTemplates"] = claims
	}
	return out
}

// projectPod reuses the reference extractor without keeping the original
// spec.
func projectPod(spec map[string]any) map[string]any {
	var refs Dependencies
	podReferences(&refs, spec)
	var containers, volumes []any
	for _, image := range refs.Images {
		containers = append(containers, map[string]any{"image": image})
	}
	for _, name := range refs.ConfigMaps {
		volumes = append(volumes, map[string]any{"configMap": map[string]any{"name": name}})
	}
	for _, name := range refs.Secrets {
		volumes = append(volumes, map[string]any{"secret": map[string]any{"secretName": name}})
	}
	for _, name := range refs.PVCs {
		volumes = append(volumes, map[string]any{"persistentVolumeClaim": map[string]any{"claimName": name}})
	}
	for _, volume := range array(spec["volumes"]) {
		if volume["ephemeral"] != nil {
			volumes = append(volumes, map[string]any{"name": volume["name"], "ephemeral": map[string]any{}})
		}
	}
	return map[string]any{"containers": containers, "volumes": volumes}
}

func stringMap(values map[string]string) map[string]any {
	out := make(map[string]any, len(values))
	for key, value := range values {
		out[key] = value
	}
	return out
}

func record(value any) map[string]any {
	m, _ := value.(map[string]any)
	if m == nil {
		return map[string]any{}
	}
	return m
}

func array(value any) []map[string]any {
	items, _ := value.([]any)
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		out = append(out, record(item))
	}
	return out
}
