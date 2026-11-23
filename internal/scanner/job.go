// Package scanner dispatches image-volume Trivy Pods, at most Parallelism at once.
package scanner

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/utils/ptr"
)

type Config struct {
	CPURequest                                                           string
	Strategy                                                             string
	ReaderServiceAccount                                                 string
	Instance, ServiceAccount                                             string
	Namespace, Image, TrivyImage, DatabaseImage, URL, Audience, CacheDir string
	PriorityClass                                                        string
	// Added to scan Pods, which pull the operator and database images.
	PullSecrets []string
	MaxBytes    int64
	// Adds CAP_DAC_READ_SEARCH to Trivy, inside the scan Pod's user
	// namespace, so files owned by other image users are readable.
	ReadAllFiles bool
	// Scan Pods running at once; defaults to 2.
	Parallelism int
	// Stop dispatching while this many failed scan Pods remain for diagnosis.
	MaxFailedPods int
}

func Key(digest, image string, versions ...string) string {
	sum := sha256.Sum256([]byte(digest + "\x00" + image + "\x00" + strings.Join(versions, "\x00") + "\x00cyclonedx-vuln-v2"))
	return hex.EncodeToString(sum[:])
}

// Read coverage is part of artifact identity: enabling the namespaced read
// capability must not reuse a failed attempt budget or a narrower artifact.
func (c Config) artifactKey(digest string) string {
	versions := []string{c.TrivyImage, c.DatabaseImage}
	if c.Strategy == StrategyWorkloadNamespace {
		versions = append(versions, StrategyWorkloadNamespace)
	}
	if c.ReadAllFiles {
		versions = append(versions, "dac-read-search")
	}
	return Key(digest, c.Image, versions...)
}

func ScanPod(c Config, key, imageName, imageUID, reference, hostname, architecture, name string) *corev1.Pod {
	return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: c.Namespace, Labels: map[string]string{"app": c.scanServiceAccount(), "driftmower-scan": "driftmower-scan", "driftmower.io/scan-key": key[:40]}, Annotations: map[string]string{"driftmower.io/artifact-key": key, "driftmower.io/container-image": imageName}, OwnerReferences: []metav1.OwnerReference{{APIVersion: "codemowers.io/v1alpha1", Kind: "ContainerImage", Name: imageName, UID: types.UID(imageUID)}}}, Spec: corev1.PodSpec{
		PriorityClassName: c.PriorityClass, ActiveDeadlineSeconds: ptr.To(int64((15 * time.Minute).Seconds())),
		ServiceAccountName: c.scanServiceAccount(), AutomountServiceAccountToken: ptr.To(false), RestartPolicy: corev1.RestartPolicyNever, ImagePullSecrets: pullSecrets(c.PullSecrets),
		Tolerations:  []corev1.Toleration{{Key: "node-role.kubernetes.io/control-plane", Operator: corev1.TolerationOpExists, Effect: corev1.TaintEffectNoSchedule}, {Key: "node-role.kubernetes.io/master", Operator: corev1.TolerationOpExists, Effect: corev1.TaintEffectNoSchedule}},
		NodeSelector: map[string]string{"kubernetes.io/hostname": hostname, "kubernetes.io/arch": architecture}, HostUsers: ptr.To(false),
		SecurityContext: &corev1.PodSecurityContext{RunAsNonRoot: ptr.To(true), RunAsUser: ptr.To[int64](65532), RunAsGroup: ptr.To[int64](65532), FSGroup: ptr.To[int64](65532)},
		InitContainers: []corev1.Container{{
			Name: "analyze-image", Image: c.Image, Command: []string{"/driftmower-operator", "analyze-image"},
			Env:       []corev1.EnvVar{{Name: "UPLOAD_URL", Value: c.URL + "/internal/scans/" + name}},
			Resources: c.scanResources(), SecurityContext: c.trivySecurity(), TerminationMessagePolicy: corev1.TerminationMessageFallbackToLogsOnError,
			VolumeMounts: []corev1.VolumeMount{{Name: "target", MountPath: "/target", ReadOnly: true}, {Name: "result", MountPath: "/result"}, {Name: "upload-token", MountPath: "/token", ReadOnly: true}},
		}, {
			Name: "trivy", Image: c.TrivyImage, ImagePullPolicy: corev1.PullIfNotPresent,
			Command: []string{"sh", "-ec", scanCommand, "trivy"}, Args: ScanArgs(),
			Env:       []corev1.EnvVar{{Name: "TMPDIR", Value: "/tmp"}},
			Resources: c.scanResources(), SecurityContext: c.trivySecurity(),
			TerminationMessagePolicy: corev1.TerminationMessageFallbackToLogsOnError,
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
			Resources:       corev1.ResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("10m"), corev1.ResourceMemory: resource.MustParse("64Mi")}, Limits: corev1.ResourceList{corev1.ResourceMemory: resource.MustParse("256Mi")}},
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
	}}
}

func pullSecrets(names []string) []corev1.LocalObjectReference {
	var refs []corev1.LocalObjectReference
	for _, n := range names {
		refs = append(refs, corev1.LocalObjectReference{Name: n})
	}
	return refs
}

// Trivy skips files it cannot read without failing, so the scan refuses to
// start unless every file and directory is readable: an incomplete scan must
// not look clean. Trivy initializes its Java DB lazily when it encounters an
// archive; exclude those only when the mounted database lacks the Java index.
const scanCommand = `unreadable=$(find /target -type f ! -perm -004 -exec sh -c 'for f; do { true < "$f"; } 2>/dev/null || echo "$f"; done' sh {} + 2>&1) || true
if [ -n "$unreadable" ]; then
  paths=$(printf '%s\n' "$unreadable" | sed -e 's|^find: ||' -e 's|: Permission denied$||' -e 's|^/target||')
  printf '%s\n' "$paths" >&2
  printf 'scan would be incomplete, unreadable paths in the image (%s): %s' "$(printf '%s\n' "$paths" | wc -l)" "$(printf '%s\n' "$paths" | head -5 | tr '\n' ' ')" > /dev/termination-log
  exit 1
fi
if [ ! -s /cache/java-db/trivy-java.db ]; then
  if [ -n "$(find /target -type f \( -iname '*.jar' -o -iname '*.war' -o -iname '*.ear' -o -iname '*.par' \) -print -quit)" ]; then
    echo 'Java DB unavailable: skipping JAR/WAR/EAR/PAR archives; Java archive coverage is excluded' >&2
    printf java_db_unavailable > /result/partial-reason
  fi
  export TRIVY_SKIP_FILES='**/*.[jJ][aA][rR],**/*.[wW][aA][rR],**/*.[eE][aA][rR],**/*.[pP][aA][rR]'
fi
cp /cache/db/metadata.json /result/db-metadata.json
exec trivy "$@"`

// The scanner has no remote database server and never updates either mounted DB.
func ScanArgs() []string {
	return []string{"rootfs", "--cache-dir", "/cache", "--cache-backend", "memory", "--skip-db-update", "--skip-java-db-update", "--skip-check-update", "--skip-version-check", "--offline-scan", "--scanners", "vuln", "--format", "cyclonedx", "--output", "/result/sbom.json", "/target"}
}
func scanSecurity() *corev1.SecurityContext {
	return &corev1.SecurityContext{AllowPrivilegeEscalation: ptr.To(false), ReadOnlyRootFilesystem: ptr.To(true), Capabilities: &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}}}
}

// Trivy runs as root of the Pod's user namespace (hostUsers: false), which
// owns the image's root files but is unprivileged on the Node.
func (c Config) trivySecurity() *corev1.SecurityContext {
	sc := scanSecurity()
	sc.RunAsUser, sc.RunAsGroup, sc.RunAsNonRoot = ptr.To[int64](0), ptr.To[int64](0), ptr.To(false)
	if c.ReadAllFiles {
		sc.Capabilities.Add = []corev1.Capability{"DAC_READ_SEARCH"}
	}
	return sc
}
func (c Config) scanResources() corev1.ResourceRequirements {
	cpu := "100m"
	if c.CPURequest != "" {
		cpu = c.CPURequest
	}
	return corev1.ResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse(cpu), corev1.ResourceMemory: resource.MustParse("256Mi")}, Limits: corev1.ResourceList{corev1.ResourceMemory: resource.MustParse("2Gi"), corev1.ResourceEphemeralStorage: resource.MustParse("2Gi")}}
}

func (c Config) scanServiceAccount() string {
	if c.ServiceAccount != "" {
		return c.ServiceAccount
	}
	return "driftmower-scan"
}

func (c Config) readerServiceAccount() string {
	if c.ReaderServiceAccount != "" {
		return c.ReaderServiceAccount
	}
	return "driftmower-mcp"
}
