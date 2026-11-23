package workloads

import (
	"slices"
	"strings"

	batchv1 "k8s.io/api/batch/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestAnalyzePodSecurity(t *testing.T) {
	kata, zero, uid, yes, no := "kata", int64(0), int64(1000), true, false
	for name, tc := range map[string]struct {
		pod  corev1.PodSpec
		want PodSecurity
	}{
		"image default":  {corev1.PodSpec{Containers: []corev1.Container{{Name: "app"}}}, PodSecurity{User: "image"}},
		"user namespace": {corev1.PodSpec{HostUsers: &no, Containers: []corev1.Container{{Name: "app"}}}, PodSecurity{User: "image", UserNamespace: true}},
		"pod non-root":   {corev1.PodSpec{SecurityContext: &corev1.PodSecurityContext{RunAsNonRoot: &yes}, Containers: []corev1.Container{{Name: "app"}}}, PodSecurity{User: "nonroot"}},
		"container uid overrides pod": {corev1.PodSpec{
			SecurityContext: &corev1.PodSecurityContext{RunAsUser: &uid},
			Containers:      []corev1.Container{{Name: "a"}, {Name: "b", SecurityContext: &corev1.SecurityContext{RunAsUser: &zero}}},
		}, PodSecurity{User: "root"}},
		"kata privileged": {corev1.PodSpec{
			RuntimeClassName: &kata, HostNetwork: true,
			Containers: []corev1.Container{{Name: "app", SecurityContext: &corev1.SecurityContext{RunAsUser: &uid, Privileged: &yes,
				Capabilities: &corev1.Capabilities{Add: []corev1.Capability{"NET_ADMIN"}}}}},
		}, PodSecurity{RuntimeClassName: "kata", Sandboxed: true, User: "nonroot", Privileged: []string{"app"}, HostNamespaces: []string{"hostNetwork"}, AddedCapabilities: []string{"NET_ADMIN"}}},
	} {
		got, _ := EvaluatePod(&corev1.Pod{Spec: tc.pod})
		if got.User != tc.want.User || got.UserNamespace != tc.want.UserNamespace || got.Sandboxed != tc.want.Sandboxed || got.RuntimeClassName != tc.want.RuntimeClassName ||
			!slices.Equal(got.Privileged, tc.want.Privileged) || !slices.Equal(got.HostNamespaces, tc.want.HostNamespaces) || !slices.Equal(got.AddedCapabilities, tc.want.AddedCapabilities) {
			t.Errorf("%s: got %+v, want %+v", name, got, tc.want)
		}
	}
}

func TestPodIssues(t *testing.T) {
	zero, uid, yes, no, kata := int64(0), int64(1000), true, false, "kata"
	for name, tc := range map[string]struct {
		spec  corev1.PodSpec
		codes []string
		rank  int
	}{
		"nonroot hardened":    {corev1.PodSpec{Containers: []corev1.Container{{Name: "app", SecurityContext: &corev1.SecurityContext{RunAsUser: &uid, AllowPrivilegeEscalation: &no}}}}, nil, 3},
		"kata root":           {corev1.PodSpec{RuntimeClassName: &kata, Containers: []corev1.Container{{Name: "app", SecurityContext: &corev1.SecurityContext{RunAsUser: &zero, AllowPrivilegeEscalation: &no}}}}, nil, 4},
		"host root":           {corev1.PodSpec{HostUsers: &yes, Containers: []corev1.Container{{Name: "app", SecurityContext: &corev1.SecurityContext{RunAsUser: &zero}}}}, []string{"privilege-escalation", "root"}, 0},
		"user namespace root": {corev1.PodSpec{HostUsers: &no, Containers: []corev1.Container{{Name: "app", SecurityContext: &corev1.SecurityContext{RunAsUser: &zero, AllowPrivilegeEscalation: &no}}}}, []string{"user-namespace-root"}, 2},
		"image default":       {corev1.PodSpec{Containers: []corev1.Container{{Name: "app"}}}, []string{"privilege-escalation", "unrestricted-user"}, 1},
		"init and ephemeral evaluated": {corev1.PodSpec{SecurityContext: &corev1.PodSecurityContext{RunAsNonRoot: &yes},
			InitContainers:      []corev1.Container{{Name: "setup", SecurityContext: &corev1.SecurityContext{RunAsNonRoot: &no, RunAsUser: &zero, AllowPrivilegeEscalation: &no}}},
			EphemeralContainers: []corev1.EphemeralContainer{{EphemeralContainerCommon: corev1.EphemeralContainerCommon{Name: "debug", SecurityContext: &corev1.SecurityContext{AllowPrivilegeEscalation: &no, Privileged: &yes}}}},
		}, []string{"privilege-escalation", "privileged", "root"}, 0},
		"sysadmin implies escalation": {corev1.PodSpec{SecurityContext: &corev1.PodSecurityContext{RunAsNonRoot: &yes}, Containers: []corev1.Container{{Name: "app", SecurityContext: &corev1.SecurityContext{AllowPrivilegeEscalation: &no, Capabilities: &corev1.Capabilities{Add: []corev1.Capability{"SYS_ADMIN"}}}}}}, []string{"added-capability", "privilege-escalation"}, 3},
	} {
		t.Run(name, func(t *testing.T) {
			setTestBudgets(&tc.spec)
			got, issues := EvaluatePod(&corev1.Pod{Spec: tc.spec})
			var codes []string
			for _, i := range issues {
				codes = append(codes, i.Code)
			}
			slices.Sort(codes)
			if !slices.Equal(codes, tc.codes) || got.IsolationRank != tc.rank {
				t.Fatalf("got rank %d issues %+v, want rank %d codes %v", got.IsolationRank, issues, tc.rank, tc.codes)
			}
		})
	}
}

func TestPodSecurityOnlyReportsMountedHostVolumes(t *testing.T) {
	no, uid := false, int64(1000)
	p := &corev1.Pod{Spec: corev1.PodSpec{
		Volumes: []corev1.Volume{
			{Name: "host", VolumeSource: corev1.VolumeSource{HostPath: &corev1.HostPathVolumeSource{Path: "/var/log"}}},
			{Name: "unused", VolumeSource: corev1.VolumeSource{HostPath: &corev1.HostPathVolumeSource{Path: "/etc"}}},
		},
		Containers: []corev1.Container{{Name: "app", VolumeMounts: []corev1.VolumeMount{{Name: "host"}, {Name: "host"}}, SecurityContext: &corev1.SecurityContext{RunAsUser: &uid, AllowPrivilegeEscalation: &no}}},
	}}
	setTestBudgets(&p.Spec)
	_, issues := EvaluatePod(p)
	if len(issues) != 1 || issues[0].Code != "host-volume" || !strings.Contains(issues[0].Message, "/var/log") {
		t.Fatalf("mounted volumes: %+v", issues)
	}
}

func TestWorkloadIssueAggregation(t *testing.T) {
	zero, no := int64(0), false
	spec := corev1.PodSpec{Containers: []corev1.Container{{Name: "app", SecurityContext: &corev1.SecurityContext{RunAsUser: &zero, AllowPrivilegeEscalation: &no}}}}
	setTestBudgets(&spec)
	d := deployment(t, "web", spec, opts{})
	a := pod(t, "web-a", spec, opts{owners: []metav1.OwnerReference{ownerRef("Deployment", "web", "apps/v1")}})
	b := pod(t, "web-b", spec, opts{owners: a.OwnerReferences})
	retired := project(t, "Pod", &corev1.Pod{ObjectMeta: objMeta("Pod", "web-old", opts{owners: a.OwnerReferences}), Spec: spec, Status: corev1.PodStatus{Phase: corev1.PodSucceeded}})
	orphan := pod(t, "standalone", spec, opts{})
	got := BuildInventory(ns, []SourceItems{{Source: sourceFor(t, "Deployment"), Items: []*Node{d}}, {Source: sourceFor(t, "Pod"), Items: []*Node{a, b, retired, orphan}}}, map[string]bool{})
	for _, w := range got {
		if len(w.Issues) != 1 {
			t.Fatalf("%s issues: %+v", w.Name, w.Issues)
		}
		want := 2
		if w.Kind == "Namespace" {
			want = 1
			if len(w.StandalonePods) != 1 || len(w.StandalonePods[0].Issues) != 1 {
				t.Fatalf("standalone issues lost: %+v", w.StandalonePods)
			}
		}
		if w.Issues[0].PodCount != want {
			t.Fatalf("%s counts: %+v", w.Name, w.Issues)
		}
	}
	if len(got) != 2 {
		t.Fatalf("expected workload and orphan bucket, got %+v", got)
	}
	// Updating a replica replaces its cached evaluation; resolved issues disappear.
	a.Pod.Issues = nil
	b.Pod.Issues = nil
	got = BuildInventory(ns, []SourceItems{{Source: sourceFor(t, "Deployment"), Items: []*Node{d}}, {Source: sourceFor(t, "Pod"), Items: []*Node{a, b, retired}}}, map[string]bool{})
	if len(got) != 1 || len(got[0].Issues) != 0 {
		t.Fatalf("resolved issues retained: %+v", got)
	}
}

func setTestBudgets(spec *corev1.PodSpec) {
	for i := range spec.Containers {
		spec.Containers[i].Resources = testBudget()
	}
	for i := range spec.InitContainers {
		spec.InitContainers[i].Resources = testBudget()
	}
}
func testBudget() corev1.ResourceRequirements {
	return corev1.ResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("100m"), corev1.ResourceMemory: resource.MustParse("32Mi")}, Limits: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("1"), corev1.ResourceMemory: resource.MustParse("128Mi")}}
}

func TestMissingResourceIssues(t *testing.T) {
	no, yes := false, true
	for name, tc := range map[string]struct {
		resources corev1.ResourceRequirements
		pod       *corev1.ResourceRequirements
		want      []string
	}{
		"all missing":        {want: []string{"missing-cpu-limit", "missing-cpu-request", "missing-memory-limit", "missing-memory-request"}},
		"all declared":       {resources: testBudget()},
		"pod budget":         {pod: func() *corev1.ResourceRequirements { r := testBudget(); return &r }()},
		"zero requests":      {resources: corev1.ResourceRequirements{Limits: testBudget().Limits}, want: []string{"missing-cpu-request", "missing-memory-request"}},
		"partial pod budget": {pod: &corev1.ResourceRequirements{Requests: testBudget().Requests}, want: []string{"missing-cpu-limit", "missing-memory-limit"}},
	} {
		t.Run(name, func(t *testing.T) {
			_, issues := EvaluatePod(&corev1.Pod{Spec: corev1.PodSpec{Resources: tc.pod, Containers: []corev1.Container{{Name: "app", Resources: tc.resources, SecurityContext: &corev1.SecurityContext{RunAsNonRoot: &yes, AllowPrivilegeEscalation: &no}}}}})
			var codes []string
			for _, issue := range issues {
				codes = append(codes, issue.Code)
			}
			slices.Sort(codes)
			if !slices.Equal(codes, tc.want) {
				t.Fatalf("got %+v, want %v", issues, tc.want)
			}
		})
	}
}

func TestTerminalPodIssuePolicy(t *testing.T) {
	for _, phase := range []corev1.PodPhase{corev1.PodRunning, corev1.PodSucceeded, corev1.PodFailed} {
		for _, terminating := range []bool{false, true} {
			for _, jobOwned := range []bool{false, true} {
				name := string(phase)
				metadata := objMeta("Pod", name, opts{})
				if jobOwned {
					metadata.OwnerReferences = []metav1.OwnerReference{ownerRef("Job", "run", "batch/v1")}
				} else {
					metadata.OwnerReferences = []metav1.OwnerReference{ownerRef("Deployment", "web", "apps/v1")}
				}
				if terminating {
					now := metav1.Now()
					metadata.DeletionTimestamp = &now
				}
				p := project(t, "Pod", &corev1.Pod{ObjectMeta: metadata, Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "app"}}}, Status: corev1.PodStatus{Phase: phase}})
				want := jobOwned || (phase == corev1.PodRunning && !terminating)
				if (len(p.Pod.Issues) > 0) != want {
					t.Fatalf("phase=%s terminating=%v Job=%v issues=%+v", phase, terminating, jobOwned, p.Pod.Issues)
				}
				if p.Pod.JobOwned != jobOwned {
					t.Fatalf("lost direct Job ownership")
				}
			}
		}
	}
	// Keep completed Job evidence even when the top-level owner is a CronJob.
	cron := project(t, "CronJob", &batchv1.CronJob{ObjectMeta: objMeta("CronJob", "cron", opts{})})
	job := project(t, "Job", &batchv1.Job{ObjectMeta: objMeta("Job", "run", opts{owners: []metav1.OwnerReference{ownerRef("CronJob", "cron", "batch/v1")}})})
	p := project(t, "Pod", &corev1.Pod{ObjectMeta: objMeta("Pod", "done", opts{owners: []metav1.OwnerReference{ownerRef("Job", "run", "batch/v1")}}), Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "app"}}}, Status: corev1.PodStatus{Phase: corev1.PodSucceeded}})
	result, _ := graph(t, cron, job, p)
	if len(result) != 1 || result[0].Kind != "CronJob" || len(result[0].Issues) == 0 {
		t.Fatalf("Job issues lost through CronJob: %+v", result)
	}
}

func TestKataGuestPrivilegesAreFactsWithoutHostSecurityIssues(t *testing.T) {
	kata, yes, zero := "kata", true, int64(0)
	pod := &corev1.Pod{Spec: corev1.PodSpec{RuntimeClassName: &kata, Containers: []corev1.Container{{Name: "game", SecurityContext: &corev1.SecurityContext{RunAsUser: &zero, Privileged: &yes, AllowPrivilegeEscalation: &yes, Capabilities: &corev1.Capabilities{Add: []corev1.Capability{"SYS_ADMIN"}}}}}}}
	setTestBudgets(&pod.Spec)
	facts, issues := EvaluatePod(pod)
	if len(issues) != 0 || !facts.Sandboxed || len(facts.Privileged) != 1 || len(facts.AddedCapabilities) != 1 {
		t.Fatalf("guest privileges became host issues or facts were discarded: %+v %+v", facts, issues)
	}
	pod.Spec.HostNetwork = true
	pod.Spec.Volumes = []corev1.Volume{{Name: "host", VolumeSource: corev1.VolumeSource{HostPath: &corev1.HostPathVolumeSource{Path: "/srv"}}}}
	pod.Spec.Containers[0].VolumeMounts = []corev1.VolumeMount{{Name: "host", MountPath: "/host"}}
	_, issues = EvaluatePod(pod)
	var codes []string
	for _, issue := range issues {
		codes = append(codes, issue.Code)
	}
	slices.Sort(codes)
	if !slices.Equal(codes, []string{"host-volume", "hostNetwork"}) {
		t.Fatalf("host exposures hidden: %+v", issues)
	}
}

func TestPodIssuesCountContainersWithoutNamesOrDuplicateEvidence(t *testing.T) {
	yes, zero := true, int64(0)
	spec := corev1.PodSpec{Containers: []corev1.Container{
		{Name: "private-name-one", SecurityContext: &corev1.SecurityContext{RunAsUser: &zero, Privileged: &yes, Capabilities: &corev1.Capabilities{Add: []corev1.Capability{"NET_ADMIN", "NET_ADMIN"}}}, VolumeMounts: []corev1.VolumeMount{{Name: "host"}, {Name: "alias"}}},
		{Name: "private-name-two", SecurityContext: &corev1.SecurityContext{RunAsUser: &zero, Capabilities: &corev1.Capabilities{Add: []corev1.Capability{"NET_ADMIN"}}}, VolumeMounts: []corev1.VolumeMount{{Name: "host"}}},
	}, Volumes: []corev1.Volume{
		{Name: "host", VolumeSource: corev1.VolumeSource{HostPath: &corev1.HostPathVolumeSource{Path: "/srv"}}},
		{Name: "alias", VolumeSource: corev1.VolumeSource{HostPath: &corev1.HostPathVolumeSource{Path: "/srv"}}},
	}}
	_, issues := EvaluatePod(&corev1.Pod{Spec: spec})
	for _, issue := range issues {
		if strings.Contains(issue.Message, "private-name") {
			t.Fatalf("container name leaked: %+v", issue)
		}
		want := 2
		if issue.Code == "privileged" {
			want = 1
		}
		if issue.ContainerCount != want {
			t.Fatalf("wrong affected container count: %+v want %d", issue, want)
		}
	}
	if len(issues) != 9 {
		t.Fatalf("expected grouped root, privileged, escalation, capability, host mount and four budgets: %+v", issues)
	}
	// Different container names and fewer affected containers still merge into
	// one workload issue, with affected-container and Pod counts kept separately.
	spec.Containers = spec.Containers[1:]
	spec.Containers[0].Name = "another-private-name"
	_, other := EvaluatePod(&corev1.Pod{Spec: spec})
	var merged []WorkloadIssue
	mergeIssues(&merged, issues)
	mergeIssues(&merged, other)
	for _, issue := range merged {
		wantContainers, wantPods := 3, 2
		if issue.Code == "privileged" {
			wantContainers, wantPods = 1, 1
		}
		if issue.ContainerCount != wantContainers || issue.PodCount != wantPods {
			t.Fatalf("merged counts %+v", issue)
		}
	}
}

func TestScanPodIdentificationUsesLabelNotName(t *testing.T) {
	for _, tc := range []struct {
		name   string
		labels map[string]string
		want   bool
	}{
		{"ordinary-name", map[string]string{"driftmower-scan": "driftmower-scan"}, true},
		{"driftmower-scan-lookalike", nil, false},
		{"wrong-label", map[string]string{"driftmower-scan": "other"}, false},
	} {
		p := project(t, "Pod", &corev1.Pod{ObjectMeta: func() metav1.ObjectMeta { m := objMeta("Pod", tc.name, opts{}); m.Labels = tc.labels; return m }()})
		if p.Pod.ScanPod != tc.want {
			t.Fatalf("%s scanPod=%v", tc.name, p.Pod.ScanPod)
		}
	}
}
