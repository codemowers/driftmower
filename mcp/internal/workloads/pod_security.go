package workloads

import (
	"slices"
	"strings"

	corev1 "k8s.io/api/core/v1"
)

type WorkloadIssue struct {
	Code           string `json:"code"`
	Severity       string `json:"severity"`
	Message        string `json:"message"`
	PodCount       int    `json:"podCount,omitempty"`
	ContainerCount int    `json:"containerCount,omitempty"`
}

// PodSecurity summarises how a Pod's containers run, from its spec alone.
type PodSecurity struct {
	IsolationRank    int    `json:"isolationRank"`
	RuntimeClassName string `json:"runtimeClassName,omitempty"`
	// Runs in a Kata Containers VM: its RuntimeClass is a kata one.
	Sandboxed bool `json:"sandboxed"`
	// root when a container runs as UID 0; nonroot when every container sets
	// a non-zero UID or runAsNonRoot; image when a container leaves the user
	// to its image, which may be root.
	User string `json:"user"`
	// hostUsers: false: the Pod has its own user namespace, so its UIDs,
	// root included, map to unprivileged UIDs on the host.
	UserNamespace bool `json:"userNamespace,omitempty"`
	// Containers with privileged: true.
	Privileged []string `json:"privileged,omitempty"`
	// hostNetwork, hostPID and hostIPC when set.
	HostNamespaces []string `json:"hostNamespaces,omitempty"`
	// Capabilities added beyond the runtime's defaults.
	AddedCapabilities []string `json:"addedCapabilities,omitempty"`
}

func EvaluatePod(pod *corev1.Pod) (PodSecurity, []WorkloadIssue) {
	var issues []WorkloadIssue
	out := PodSecurity{User: "nonroot"}
	if rc := pod.Spec.RuntimeClassName; rc != nil {
		out.RuntimeClassName = *rc
		out.Sandboxed = strings.Contains(strings.ToLower(*rc), "kata")
	}
	out.UserNamespace = pod.Spec.HostUsers != nil && !*pod.Spec.HostUsers
	if pod.Spec.HostNetwork {
		out.HostNamespaces = append(out.HostNamespaces, "hostNetwork")
	}
	if pod.Spec.HostPID {
		out.HostNamespaces = append(out.HostNamespaces, "hostPID")
	}
	if pod.Spec.HostIPC {
		out.HostNamespaces = append(out.HostNamespaces, "hostIPC")
	}
	var podUser *int64
	podNonRoot := false
	if sc := pod.Spec.SecurityContext; sc != nil {
		podUser = sc.RunAsUser
		podNonRoot = sc.RunAsNonRoot != nil && *sc.RunAsNonRoot
	}
	rank := map[string]int{"nonroot": 0, "image": 1, "root": 2}
	containers := append(slices.Clone(pod.Spec.InitContainers), pod.Spec.Containers...)
	resourceContainers := len(containers)
	for _, c := range pod.Spec.EphemeralContainers {
		containers = append(containers, corev1.Container{Name: c.Name, SecurityContext: c.SecurityContext, VolumeMounts: c.VolumeMounts, VolumeDevices: c.VolumeDevices})
	}
	containerIndex := -1
	counted := map[int]map[int]bool{}
	issue := func(code, severity, message string) {
		i := slices.IndexFunc(issues, func(i WorkloadIssue) bool { return i.Code == code && i.Message == message })
		if i < 0 {
			issues = append(issues, WorkloadIssue{Code: code, Severity: severity, Message: message})
			i = len(issues) - 1
		}
		if containerIndex >= 0 {
			if counted[i] == nil {
				counted[i] = map[int]bool{}
			}
			if !counted[i][containerIndex] {
				counted[i][containerIndex] = true
				issues[i].ContainerCount++
			}
		}
	}
	for _, ns := range out.HostNamespaces {
		issue(ns, "critical", "Pod shares the host's "+ns+" namespace")
	}
	for index, c := range containers {
		containerIndex = index
		// Ephemeral debug containers cannot declare resource requests or limits.
		if index < resourceContainers {
			for _, resource := range []corev1.ResourceName{corev1.ResourceCPU, corev1.ResourceMemory} {
				for _, setting := range []string{"request", "limit"} {
					values := c.Resources.Requests
					var budget corev1.ResourceList
					if setting == "limit" {
						values = c.Resources.Limits
					}
					if pod.Spec.Resources != nil {
						budget = pod.Spec.Resources.Requests
						if setting == "limit" {
							budget = pod.Spec.Resources.Limits
						}
					}
					value, podValue := values[resource], budget[resource]
					if value.Sign() <= 0 && podValue.Sign() <= 0 {
						issue("missing-"+string(resource)+"-"+setting, "warning", "Containers have no "+string(resource)+" "+setting)
					}
				}
			}
		}
		user, nonRoot := podUser, podNonRoot
		escalation := true // Kubernetes defaults allowPrivilegeEscalation to true.
		if sc := c.SecurityContext; sc != nil {
			if sc.AllowPrivilegeEscalation != nil {
				escalation = *sc.AllowPrivilegeEscalation
			}
			if sc.RunAsUser != nil {
				user = sc.RunAsUser
			}
			if sc.RunAsNonRoot != nil {
				nonRoot = *sc.RunAsNonRoot
			}
			if sc.Privileged != nil && *sc.Privileged {
				out.Privileged = append(out.Privileged, c.Name)
				escalation = true
				if !out.Sandboxed {
					issue("privileged", "critical", "Containers are privileged")
				}
			}
			if sc.Capabilities != nil {
				for _, cap := range sc.Capabilities.Add {
					if !out.Sandboxed {
						issue("added-capability", "warning", "Containers add capability "+string(cap))
					}
					if cap == "SYS_ADMIN" {
						escalation = true
					}
					if !slices.Contains(out.AddedCapabilities, string(cap)) {
						out.AddedCapabilities = append(out.AddedCapabilities, string(cap))
					}
				}
			}
		}
		verdict := "image"
		switch {
		case user != nil && *user == 0:
			verdict = "root"
		case user != nil || nonRoot:
			// The kubelet refuses to start a runAsNonRoot container as UID 0.
			verdict = "nonroot"
		}
		if rank[verdict] > rank[out.User] {
			out.User = verdict
		}
		if !out.Sandboxed && verdict != "nonroot" {
			switch {
			case out.UserNamespace:
				issue("user-namespace-root", "warning", "Containers may run as root inside a user namespace (hostUsers: false)")
			case verdict == "root":
				issue("root", "critical", "Containers are configured to run as UID 0 on the host kernel")
			default:
				issue("unrestricted-user", "critical", "Containers have no non-root user guarantee; their image user may be root")
			}
		}
		if escalation && !out.Sandboxed {
			issue("privilege-escalation", "warning", "Containers allow privilege escalation")
		}
		for _, volume := range pod.Spec.Volumes {
			if volume.HostPath == nil {
				continue
			}
			mounted := slices.ContainsFunc(c.VolumeMounts, func(m corev1.VolumeMount) bool { return m.Name == volume.Name }) ||
				slices.ContainsFunc(c.VolumeDevices, func(d corev1.VolumeDevice) bool { return d.Name == volume.Name })
			if mounted {
				issue("host-volume", "warning", "Containers mount host path "+volume.HostPath.Path)
			}
		}
	}
	slices.Sort(out.AddedCapabilities)
	switch {
	case out.Sandboxed:
		out.IsolationRank = 4
	case out.User == "nonroot":
		out.IsolationRank = 3
	case out.UserNamespace:
		out.IsolationRank = 2
	case out.User == "image":
		out.IsolationRank = 1
	default:
		out.IsolationRank = 0
	}
	sortIssues(issues)

	return out, issues
}

func sortIssues(issues []WorkloadIssue) {
	slices.SortFunc(issues, func(a, b WorkloadIssue) int {
		if c := strings.Compare(a.Severity, b.Severity); c != 0 {
			return c
		}
		return strings.Compare(a.Code+"/"+a.Message, b.Code+"/"+b.Message)
	})
}

// Each Pod contributes at most once to an issue, regardless of replica count.
func mergeIssues(target *[]WorkloadIssue, issues []WorkloadIssue) {
	for _, issue := range issues {
		i := slices.IndexFunc(*target, func(existing WorkloadIssue) bool {
			return existing.Code == issue.Code && existing.Message == issue.Message
		})
		count := issue.PodCount
		if count == 0 {
			count = 1
		}
		if i >= 0 {
			(*target)[i].PodCount += count
			(*target)[i].ContainerCount += issue.ContainerCount
		} else {
			issue.PodCount = count
			*target = append(*target, issue)
		}
	}
}
