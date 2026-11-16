package mcpserver

import (
	"slices"
	"strings"

	corev1 "k8s.io/api/core/v1"
)

// podSecurity summarises how a Pod's containers run, from its spec alone.
type podSecurity struct {
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

func analyzePodSecurity(pod *corev1.Pod) podSecurity {
	out := podSecurity{User: "nonroot"}
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
	for _, c := range containers {
		user, nonRoot := podUser, podNonRoot
		if sc := c.SecurityContext; sc != nil {
			if sc.RunAsUser != nil {
				user = sc.RunAsUser
			}
			if sc.RunAsNonRoot != nil {
				nonRoot = *sc.RunAsNonRoot
			}
			if sc.Privileged != nil && *sc.Privileged {
				out.Privileged = append(out.Privileged, c.Name)
			}
			if sc.Capabilities != nil {
				for _, cap := range sc.Capabilities.Add {
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
	}
	slices.Sort(out.AddedCapabilities)

	return out
}
