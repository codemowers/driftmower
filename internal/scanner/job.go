// Package scanner reconciles image-volume Trivy Jobs; Kubernetes quota admits scan Pods.
package scanner

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"slices"
	"strings"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/utils/ptr"
)

type Config struct {
	Namespace, Image, TrivyImage, DatabaseImage, URL, Audience, CacheDir string
	PriorityClass                                                        string
	MaxBytes                                                             int64
}

func Key(digest, image string, versions ...string) string {
	sum := sha256.Sum256([]byte(digest + "\x00" + image + "\x00" + strings.Join(versions, "\x00") + "\x00cyclonedx-vuln-v2"))
	return hex.EncodeToString(sum[:])
}

func JobName(imageName, digest string) string { return "scan-" + Key(digest, imageName)[:40] }

func ScanJob(c Config, key, imageName, imageUID, reference, hostname string, names ...string) *batchv1.Job {
	name := "scan-" + key[:40]
	if len(names) > 0 {
		name = names[0]
	}
	return &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: c.Namespace, Labels: map[string]string{"app": "driftmower-scan", "driftmower.io/scan-key": key[:40]}, Annotations: map[string]string{"driftmower.io/artifact-key": key}, OwnerReferences: []metav1.OwnerReference{{APIVersion: "codemowers.io/v1alpha1", Kind: "ContainerImage", Name: imageName, UID: types.UID(imageUID)}}}, Spec: batchv1.JobSpec{
		BackoffLimit: ptr.To[int32](6), TTLSecondsAfterFinished: ptr.To[int32](failedJobTTL),
		Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": "driftmower-scan"}, Annotations: map[string]string{"driftmower.io/container-image": imageName}}, Spec: corev1.PodSpec{
			PriorityClassName: c.PriorityClass, ActiveDeadlineSeconds: ptr.To(int64((15 * time.Minute).Seconds())),
			ServiceAccountName: "driftmower-scan", AutomountServiceAccountToken: ptr.To(false), RestartPolicy: corev1.RestartPolicyNever,
			NodeSelector: map[string]string{"kubernetes.io/hostname": hostname}, HostUsers: ptr.To(false),
			SecurityContext: &corev1.PodSecurityContext{RunAsNonRoot: ptr.To(true), RunAsUser: ptr.To[int64](65532), RunAsGroup: ptr.To[int64](65532), FSGroup: ptr.To[int64](65532), SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault}},
			InitContainers: []corev1.Container{{
				Name: "trivy", Image: c.TrivyImage, ImagePullPolicy: corev1.PullIfNotPresent,
				Command: []string{"trivy"}, Args: ScanArgs(),
				Env:       []corev1.EnvVar{{Name: "TMPDIR", Value: "/tmp"}},
				Resources: scanResources(), SecurityContext: scanSecurity(),
				VolumeMounts: []corev1.VolumeMount{
					{Name: "target", MountPath: "/target", ReadOnly: true},
					{Name: "database", MountPath: "/cache/db", SubPath: "db", ReadOnly: true},
					{Name: "database", MountPath: "/cache/java-db", SubPath: "java-db", ReadOnly: true},
					{Name: "scratch", MountPath: "/tmp"},
					{Name: "cache", MountPath: "/cache"},
					{Name: "result", MountPath: "/result"},
				},
			}},
			Containers: []corev1.Container{{
				Name: "upload", Image: c.Image, Command: []string{"/driftmower-operator", "upload"},
				Env:             []corev1.EnvVar{{Name: "UPLOAD_URL", Value: c.URL + "/internal/scans/" + name}},
				Resources:       corev1.ResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("10m"), corev1.ResourceMemory: resource.MustParse("64Mi")}, Limits: corev1.ResourceList{corev1.ResourceMemory: resource.MustParse("128Mi")}},
				SecurityContext: scanSecurity(),
				VolumeMounts:    []corev1.VolumeMount{{Name: "result", MountPath: "/result", ReadOnly: true}, {Name: "upload-token", MountPath: "/token", ReadOnly: true}},
			}},
			Volumes: []corev1.Volume{
				{Name: "target", VolumeSource: corev1.VolumeSource{Image: &corev1.ImageVolumeSource{Reference: reference, PullPolicy: corev1.PullNever}}},
				{Name: "database", VolumeSource: corev1.VolumeSource{Image: &corev1.ImageVolumeSource{Reference: c.DatabaseImage, PullPolicy: corev1.PullIfNotPresent}}},
				{Name: "scratch", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{SizeLimit: ptr.To(resource.MustParse("1Gi"))}}},
				{Name: "cache", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{SizeLimit: ptr.To(resource.MustParse("512Mi"))}}},
				{Name: "result", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{SizeLimit: ptr.To(resource.MustParse("64Mi"))}}},
				{Name: "upload-token", VolumeSource: corev1.VolumeSource{Projected: &corev1.ProjectedVolumeSource{Sources: []corev1.VolumeProjection{{ServiceAccountToken: &corev1.ServiceAccountTokenProjection{Audience: c.Audience, ExpirationSeconds: ptr.To[int64](3600), Path: "token"}}}}}},
			},
		}},
	}}
}

// The scanner has no remote database server and never updates either mounted DB.
func ScanArgs() []string {
	return []string{"rootfs", "--cache-dir", "/cache", "--cache-backend", "memory", "--skip-db-update", "--skip-java-db-update", "--skip-check-update", "--offline-scan", "--scanners", "vuln", "--format", "cyclonedx", "--output", "/result/sbom.json", "/target"}
}
func scanSecurity() *corev1.SecurityContext {
	return &corev1.SecurityContext{AllowPrivilegeEscalation: ptr.To(false), ReadOnlyRootFilesystem: ptr.To(true), Capabilities: &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}}}
}
func scanResources() corev1.ResourceRequirements {
	return corev1.ResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("100m"), corev1.ResourceMemory: resource.MustParse("256Mi")}, Limits: corev1.ResourceList{corev1.ResourceMemory: resource.MustParse("2Gi"), corev1.ResourceEphemeralStorage: resource.MustParse("2Gi")}}
}

// Give the scheduler a bounded, stable selection of eligible cached-image hosts.
func ScanJobForNodes(c Config, key, imageName, imageUID, reference, architecture, name string, hosts []string) *batchv1.Job {
	job := ScanJob(c, key, imageName, imageUID, reference, "", name)
	hosts = slices.Clone(hosts)
	slices.Sort(hosts)
	hosts = slices.Compact(hosts)
	if len(hosts) > 0 {
		// Hash ranking gives each Job a stable pseudorandom selection,
		// spreading images across hosts without reconciliation churn.
		limit := min(len(hosts), 3)
		slices.SortFunc(hosts, func(a, b string) int {
			ha := sha256.Sum256([]byte(job.Name + "\x00" + a))
			hb := sha256.Sum256([]byte(job.Name + "\x00" + b))
			return bytes.Compare(ha[:], hb[:])
		})
		hosts = hosts[:limit]
		slices.Sort(hosts)
	}
	job.Spec.Template.Spec.NodeSelector = map[string]string{"kubernetes.io/arch": architecture}
	job.Spec.Template.Spec.Affinity = &corev1.Affinity{NodeAffinity: &corev1.NodeAffinity{RequiredDuringSchedulingIgnoredDuringExecution: &corev1.NodeSelector{NodeSelectorTerms: []corev1.NodeSelectorTerm{{MatchExpressions: []corev1.NodeSelectorRequirement{{Key: "kubernetes.io/hostname", Operator: corev1.NodeSelectorOpIn, Values: hosts}}}}}}}
	return job
}
