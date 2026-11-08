package workloads

import (
	"fmt"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func appendUnique(list []string, v string) []string {
	if v == "" {
		return list
	}
	for _, e := range list {
		if e == v {
			return list
		}
	}

	return append(list, v)
}

// podRefs extracts references only, never environment values,
// configuration data or credentials.
func podRefs(spec *corev1.PodSpec) *PodRefs {
	r := &PodRefs{}
	visit := func(image string, env []corev1.EnvVar, envFrom []corev1.EnvFromSource) {
		r.Images = appendUnique(r.Images, image)
		for _, e := range env {
			if f := e.ValueFrom; f != nil {
				if f.ConfigMapKeyRef != nil {
					r.ConfigMaps = appendUnique(r.ConfigMaps, f.ConfigMapKeyRef.Name)
				}
				if f.SecretKeyRef != nil {
					r.Secrets = appendUnique(r.Secrets, f.SecretKeyRef.Name)
				}
			}
		}
		for _, e := range envFrom {
			if e.ConfigMapRef != nil {
				r.ConfigMaps = appendUnique(r.ConfigMaps, e.ConfigMapRef.Name)
			}
			if e.SecretRef != nil {
				r.Secrets = appendUnique(r.Secrets, e.SecretRef.Name)
			}
		}
	}
	for _, c := range spec.Containers {
		visit(c.Image, c.Env, c.EnvFrom)
	}
	for _, c := range spec.InitContainers {
		visit(c.Image, c.Env, c.EnvFrom)
	}
	for _, c := range spec.EphemeralContainers {
		visit(c.Image, c.Env, c.EnvFrom)
	}
	for _, s := range spec.ImagePullSecrets {
		r.Secrets = appendUnique(r.Secrets, s.Name)
	}
	for _, v := range spec.Volumes {
		if v.ConfigMap != nil {
			r.ConfigMaps = appendUnique(r.ConfigMaps, v.ConfigMap.Name)
		}
		if v.Secret != nil {
			r.Secrets = appendUnique(r.Secrets, v.Secret.SecretName)
		}
		if v.PersistentVolumeClaim != nil {
			r.PVCs = appendUnique(r.PVCs, v.PersistentVolumeClaim.ClaimName)
		}
		if v.Projected != nil {
			for _, s := range v.Projected.Sources {
				if s.ConfigMap != nil {
					r.ConfigMaps = appendUnique(r.ConfigMaps, s.ConfigMap.Name)
				}
				if s.Secret != nil {
					r.Secrets = appendUnique(r.Secrets, s.Secret.Name)
				}
			}
		}
		if v.CSI != nil && v.CSI.NodePublishSecretRef != nil {
			r.Secrets = appendUnique(r.Secrets, v.CSI.NodePublishSecretRef.Name)
		}
		// In-tree volume plugins that still carry local Secret references.
		if v.AzureFile != nil {
			r.Secrets = appendUnique(r.Secrets, v.AzureFile.SecretName)
		}
		for _, ref := range []*corev1.LocalObjectReference{
			secretRefOf(v.CephFS), secretRefOf(v.Cinder), secretRefOf(v.FlexVolume), secretRefOf(v.ISCSI),
			secretRefOf(v.RBD), secretRefOf(v.ScaleIO), secretRefOf(v.StorageOS),
		} {
			if ref != nil {
				r.Secrets = appendUnique(r.Secrets, ref.Name)
			}
		}
		if v.Ephemeral != nil {
			r.EphemeralVolumes = appendUnique(r.EphemeralVolumes, v.Name)
		}
	}

	return r
}

func secretRefOf(source any) *corev1.LocalObjectReference {
	switch s := source.(type) {
	case *corev1.CephFSVolumeSource:
		if s != nil {
			return s.SecretRef
		}
	case *corev1.CinderVolumeSource:
		if s != nil {
			return s.SecretRef
		}
	case *corev1.FlexVolumeSource:
		if s != nil {
			return s.SecretRef
		}
	case *corev1.ISCSIVolumeSource:
		if s != nil {
			return s.SecretRef
		}
	case *corev1.RBDVolumeSource:
		if s != nil {
			return s.SecretRef
		}
	case *corev1.ScaleIOVolumeSource:
		if s != nil {
			return s.SecretRef
		}
	case *corev1.StorageOSVolumeSource:
		if s != nil {
			return s.SecretRef
		}
	}

	return nil
}

func template(t *corev1.PodTemplateSpec) Spec {
	return Spec{Pod: podRefs(&t.Spec), TemplateLabels: t.Labels}
}

// reduceMeta keeps identity, labels, ownership and the annotations the
// inventory reads.
func reduceMeta(m metav1.ObjectMeta) metav1.ObjectMeta {
	out := metav1.ObjectMeta{
		Name: m.Name, Namespace: m.Namespace, UID: m.UID, ResourceVersion: m.ResourceVersion,
		Labels: m.Labels, OwnerReferences: m.OwnerReferences,
	}
	for _, k := range keptAnnotations {
		if v, ok := m.Annotations[k]; ok {
			if out.Annotations == nil {
				out.Annotations = map[string]string{}
			}
			out.Annotations[k] = v
		}
	}

	return out
}

// Project reduces a watched object to a Node before it is cached, so no env
// values, commands, Secret data or arbitrary custom-resource specs are kept.
func Project(src Source, obj any) (*Node, error) {
	// Informers may run the transform again on an object already reduced,
	// e.g. when a relist replaces the store.
	if n, ok := obj.(*Node); ok && n.Kind == src.Kind {
		return n, nil
	}
	n := &Node{APIVersion: src.APIVersion(), Kind: src.Kind}
	// Secret and ConfigMap data must never enter the cache.
	if _, ok := obj.(*metav1.PartialObjectMetadata); src.MetadataOnly && !ok {
		return nil, fmt.Errorf("%s: metadata-only response required", src.Kind)
	}
	switch o := obj.(type) {
	case *metav1.PartialObjectMetadata:
		if !src.MetadataOnly {
			return nil, fmt.Errorf("%s: metadata-only object for a full source", src.Kind)
		}
		n.ObjectMeta = reduceMeta(o.ObjectMeta)
	case *corev1.Pod:
		n.Completed = o.Status.Phase == corev1.PodSucceeded
		n.ObjectMeta, n.Spec = reduceMeta(o.ObjectMeta), Spec{Pod: podRefs(&o.Spec)}
	case *corev1.ReplicationController:
		n.DesiredReplicas = o.Spec.Replicas
		n.ObjectMeta = reduceMeta(o.ObjectMeta)
		if o.Spec.Template != nil {
			n.Spec = template(o.Spec.Template)
		}
	case *appsv1.Deployment:
		n.DesiredReplicas = o.Spec.Replicas
		n.ObjectMeta, n.Spec = reduceMeta(o.ObjectMeta), template(&o.Spec.Template)
	case *appsv1.ReplicaSet:
		n.DesiredReplicas = o.Spec.Replicas
		n.ObjectMeta, n.Spec = reduceMeta(o.ObjectMeta), template(&o.Spec.Template)
	case *appsv1.DaemonSet:
		n.ObjectMeta, n.Spec = reduceMeta(o.ObjectMeta), template(&o.Spec.Template)
	case *appsv1.StatefulSet:
		n.DesiredReplicas = o.Spec.Replicas
		n.ObjectMeta, n.Spec = reduceMeta(o.ObjectMeta), template(&o.Spec.Template)
		n.Spec.ServiceName = o.Spec.ServiceName
		for _, c := range o.Spec.VolumeClaimTemplates {
			n.Spec.ClaimTemplates = append(n.Spec.ClaimTemplates, c.Name)
		}
	case *batchv1.Job:
		for _, condition := range o.Status.Conditions {
			if condition.Type == batchv1.JobComplete && condition.Status == corev1.ConditionTrue {
				n.Completed = true
			}
		}
		n.ObjectMeta, n.Spec = reduceMeta(o.ObjectMeta), template(&o.Spec.Template)
	case *batchv1.CronJob:
		n.ObjectMeta, n.Spec = reduceMeta(o.ObjectMeta), template(&o.Spec.JobTemplate.Spec.Template)
	case *corev1.Service:
		n.ObjectMeta, n.Spec = reduceMeta(o.ObjectMeta), Spec{Selector: o.Spec.Selector}
	case *networkingv1.Ingress:
		n.ObjectMeta = reduceMeta(o.ObjectMeta)
		if b := o.Spec.DefaultBackend; b != nil && b.Service != nil {
			n.Spec.BackendServices = appendUnique(n.Spec.BackendServices, b.Service.Name)
		}
		for _, rule := range o.Spec.Rules {
			if rule.HTTP == nil {
				continue
			}
			for _, p := range rule.HTTP.Paths {
				if p.Backend.Service != nil {
					n.Spec.BackendServices = appendUnique(n.Spec.BackendServices, p.Backend.Service.Name)
				}
			}
		}
		for _, tls := range o.Spec.TLS {
			n.Spec.TLSSecrets = appendUnique(n.Spec.TLSSecrets, tls.SecretName)
		}
	case *unstructured.Unstructured:
		n.ObjectMeta = reduceMeta(metav1.ObjectMeta{
			Name: o.GetName(), Namespace: o.GetNamespace(), UID: o.GetUID(), ResourceVersion: o.GetResourceVersion(),
			Labels: o.GetLabels(), Annotations: o.GetAnnotations(), OwnerReferences: o.GetOwnerReferences(),
		})
		switch src.Kind {
		case CertificateSource.Kind:
			n.Spec.SecretName, _, _ = unstructured.NestedString(o.Object, "spec", "secretName")
		case CNPGSource.Kind:
			for _, field := range []string{"serverTLSSecret", "serverCASecret", "clientCASecret", "replicationTLSSecret"} {
				name, _, _ := unstructured.NestedString(o.Object, "spec", "certificates", field)
				n.Spec.ReferencedSecrets = appendUnique(n.Spec.ReferencedSecrets, name)
			}
			for field, into := range map[string]*[]string{"customQueriesConfigMap": &n.Spec.ReferencedConfigMaps, "customQueriesSecret": &n.Spec.ReferencedSecrets} {
				queries, _, _ := unstructured.NestedSlice(o.Object, "spec", "monitoring", field)
				for _, q := range queries {
					if m, ok := q.(map[string]any); ok {
						name, _ := m["name"].(string)
						*into = appendUnique(*into, name)
					}
				}
			}
		}
	default:
		return nil, fmt.Errorf("%s: unexpected object %T", src.Kind, obj)
	}
	if n.UID == "" || n.Name == "" || n.Namespace == "" {
		return nil, fmt.Errorf("%s: object without uid, name or namespace", src.Kind)
	}

	return n, nil
}
