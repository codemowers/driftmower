package scanner

import (
	"fmt"
	"slices"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
)

func TestScanNodeSelection(t *testing.T) {
	for _, tc := range []struct{ n, want int }{{1, 1}, {2, 2}, {3, 3}, {4, 3}, {8, 3}, {100, 3}, {1000, 3}} {
		t.Run(fmt.Sprint(tc.n), func(t *testing.T) {
			hosts := make([]string, tc.n)
			for i := range hosts {
				hosts[i] = fmt.Sprintf("node-%04d", i)
			}
			original := slices.Clone(hosts)
			selectHosts := func(name string, input []string) []string {
				job := ScanJobForNodes(Config{}, Key("digest", "image"), "image", "uid", "image@sha256:abc", "amd64", name, input)
				return job.Spec.Template.Spec.Affinity.NodeAffinity.RequiredDuringSchedulingIgnoredDuringExecution.NodeSelectorTerms[0].MatchExpressions[0].Values
			}
			got := selectHosts("scan-a", hosts)
			if len(got) != tc.want {
				t.Fatalf("got %d hosts, want %d", len(got), tc.want)
			}
			if !slices.Equal(hosts, original) {
				t.Fatal("mutated input")
			}
			for _, host := range got {
				if !slices.Contains(original, host) {
					t.Fatalf("ineligible host %s", host)
				}
			}
			slices.Reverse(hosts)
			hosts = append(hosts, hosts[0])
			if !slices.Equal(got, selectHosts("scan-a", hosts)) {
				t.Fatal("selection changed with input order/duplicates")
			}
			if tc.n >= 100 && slices.Equal(got, selectHosts("scan-b", hosts)) {
				t.Fatal("different jobs should spread across hosts")
			}
		})
	}
}

func TestScanUsesTrivyAndTwoReadOnlyImageVolumes(t *testing.T) {
	c := Config{Namespace: "driftmower", Image: "operator@sha256:abc", TrivyImage: "trivy@sha256:def", DatabaseImage: "db@sha256:123", Audience: "scans", URL: "http://operator"}
	key := Key("sha256:target", c.Image, c.TrivyImage, c.DatabaseImage)
	j := ScanJob(c, key, "image", "uid", "registry/image@sha256:target", "actual-host-label")
	p := j.Spec.Template.Spec
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
	if len(p.InitContainers) != 1 || p.InitContainers[0].Image != c.TrivyImage {
		t.Fatal("scanner must run the Trivy image itself")
	}
	scan := p.InitContainers[0]
	if strings.Join(scan.Command, " ") != "trivy" {
		t.Fatal("execute Trivy directly")
	}
	for _, flag := range []string{"--skip-db-update", "--skip-java-db-update", "--offline-scan"} {
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
