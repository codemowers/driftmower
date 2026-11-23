package scanner

import (
	"slices"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
)

func TestScanUsesTrivyAndTwoReadOnlyImageVolumes(t *testing.T) {
	c := Config{Namespace: "driftmower", Image: "operator@sha256:abc", TrivyImage: "trivy@sha256:def", DatabaseImage: "db@sha256:123", Audience: "scans", URL: "http://operator"}
	key := Key("sha256:target", c.Image, c.TrivyImage, c.DatabaseImage)
	j := ScanPod(c, key, "image", "uid", "registry/image@sha256:target", "actual-host-label", "amd64", "scan-test")
	p := j.Spec
	if p.NodeName != "" || p.NodeSelector["kubernetes.io/hostname"] != "actual-host-label" {
		t.Fatal("must use scheduler and hostname selector")
	}
	volumes := map[string]corev1.Volume{}
	imageCount := 0
	for _, v := range p.Volumes {
		volumes[v.Name] = v
		if v.Image != nil {
			imageCount++
		}
	}
	if imageCount != 2 {
		t.Fatalf("want exactly two image volumes, got %d", imageCount)
	}
	if v := volumes["target"].Image; v == nil || v.PullPolicy != corev1.PullNever || v.Reference != "registry/image@sha256:target" {
		t.Fatal("target must be mounted from node cache without pulling")
	}
	if v := volumes["database"].Image; v == nil || v.Reference != c.DatabaseImage {
		t.Fatal("database must be mounted as an image volume")
	}
	if len(p.InitContainers) != 2 || p.InitContainers[0].Name != "analyze-image" || p.InitContainers[1].Image != c.TrivyImage {
		t.Fatal("scanner must run the Trivy image itself")
	}
	scan := p.InitContainers[1]
	if len(scan.Command) != 4 || scan.Command[2] != scanCommand || scan.Command[3] != "trivy" {
		t.Fatal("check Java DB availability before executing Trivy")
	}
	for _, flag := range []string{"--skip-db-update", "--skip-java-db-update", "--skip-version-check", "--offline-scan"} {
		if !slices.Contains(scan.Args, flag) {
			t.Fatalf("missing %s", flag)
		}
	}
	if slices.Contains(scan.Args, "--server") {
		t.Fatal("no Trivy server")
	}
	for _, mount := range scan.VolumeMounts {
		if (mount.Name == "target" || mount.Name == "database") && !mount.ReadOnly {
			t.Fatal("image mounts must be read only")
		}
		if mount.Name == "upload-token" {
			t.Fatal("scanner does not need uploader credentials")
		}
	}
	for _, mount := range p.Containers[0].VolumeMounts {
		if mount.Name == "target" || mount.Name == "database" {
			t.Fatal("uploader must not receive scanned files or DB")
		}
	}
	if p.AutomountServiceAccountToken == nil || *p.AutomountServiceAccountToken {
		t.Fatal("no Kubernetes API token in scanner")
	}
	for _, other := range []string{Key("sha256:other", c.Image, c.TrivyImage, c.DatabaseImage), Key("sha256:target", c.Image, "new-trivy", c.DatabaseImage), Key("sha256:target", c.Image, c.TrivyImage, "new-db")} {
		if key == other {
			t.Fatal("target, scanner and DB changes must each invalidate scan cache")
		}
	}
}

func TestScanPodsFollowReleaseIdentity(t *testing.T) {
	a := Config{Instance: "alpha", ServiceAccount: "alpha-scan"}
	job := ScanPod(a, Key("digest", "image"), "image", "uid", "image@sha256:target", "node-a", "amd64", "scan-test")
	if job.Spec.ServiceAccountName != "alpha-scan" || job.Labels["app"] != "alpha-scan" {
		t.Fatal("scan Pod does not use release identity")
	}
	if job.Spec.RestartPolicy != corev1.RestartPolicyNever || job.OwnerReferences[0].Kind != "ContainerImage" {
		t.Fatal("operator must own attempts directly without container or Job retries")
	}
}

func TestReadCoverageChangesArtifactIdentity(t *testing.T) {
	cfg := Config{Image: "operator", TrivyImage: "trivy", DatabaseImage: "db"}
	old := cfg.artifactKey("digest")
	if old != Key("digest", cfg.Image, cfg.TrivyImage, cfg.DatabaseImage) {
		t.Fatal("default cache identity changed")
	}
	cfg.ReadAllFiles = true
	if cfg.artifactKey("digest") == old {
		t.Fatal("read coverage reused previous artifacts and attempts")
	}
}

func TestScanCPUReservationIsConfigurableWithoutAThrottle(t *testing.T) {
	for _, tc := range []struct{ configured, want string }{{"", "100m"}, {"50m", "50m"}} {
		p := ScanPod(Config{CPURequest: tc.configured}, Key("digest", "image"), "image", "uid", "ref", "node", "amd64", "scan")
		for _, c := range p.Spec.InitContainers {
			got := c.Resources.Requests[corev1.ResourceCPU]
			if got.Cmp(resource.MustParse(tc.want)) != 0 {
				t.Fatalf("%s request %s, want %s", c.Name, got.String(), tc.want)
			}
			if _, limited := c.Resources.Limits[corev1.ResourceCPU]; limited {
				t.Fatal("background CPU request must not impose a CPU limit")
			}
		}
	}
}
