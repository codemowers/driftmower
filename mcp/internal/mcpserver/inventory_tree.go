package mcpserver

import (
	"slices"
	"time"

	"github.com/codemowers/driftmower/mcp/internal/workloads"
)

// podFacts are the Pod fields an owner carries when every one of its Pods
// agrees on them; a Pod lists only the facts it does not share.
type podFacts struct {
	Phase               string                 `json:"phase,omitempty"`
	NodeName            string                 `json:"nodeName,omitempty"`
	Security            *workloads.PodSecurity `json:"security,omitempty"`
	PriorityClassName   string                 `json:"priorityClassName,omitempty"`
	Priority            *int32                 `json:"priority,omitempty"`
	HasImagePullSecrets *bool                  `json:"hasImagePullSecrets,omitempty"`
}

type podNode struct {
	ScanPod     bool                      `json:"scanPod,omitempty"`
	Name        string                    `json:"name"`
	UID         string                    `json:"uid"`
	CreatedAt   time.Time                 `json:"createdAt"`
	IPs         []string                  `json:"ips,omitempty"`
	Containers  []workloads.PodContainer  `json:"containers"`
	Issues      []workloads.WorkloadIssue `json:"issues,omitempty"`
	JobOwned    bool                      `json:"jobOwned,omitempty"`
	Terminating bool                      `json:"terminating,omitempty"`
	podFacts
}

// ownerNode is a root owner with its Pods as descendants. A standalone Pod is
// its own owner of kind Pod and carries its runtime fields directly.
type ownerNode struct {
	ScanPod bool `json:"scanPod,omitempty"`
	*workloads.Workload
	podFacts
	IPs        []string                 `json:"ips,omitempty"`
	Containers []workloads.PodContainer `json:"containers,omitempty"`
	Pods       []podNode                `json:"pods,omitempty"`
}

type inventoryTree struct {
	Owners []*ownerNode `json:"owners"`
	// Unclaimed resources per namespace, only when requested.
	Orphans  []*workloads.Workload `json:"orphans,omitempty"`
	Warnings []string              `json:"warnings,omitempty"`
	Revision string                `json:"revision,omitempty"`
}

func finishedPod(p workloads.PodSnapshot) bool {
	return p.Phase == "Succeeded" || p.Phase == "Failed"
}

func factsOf(p workloads.PodSnapshot) podFacts {
	secrets := p.HasImagePullSecrets
	return podFacts{Phase: p.Phase, NodeName: p.NodeName, Security: p.Security, PriorityClassName: p.PriorityClassName, Priority: p.Priority, HasImagePullSecrets: &secrets}
}

// shared keeps the facts every Pod agrees on.
func shared(pods []workloads.PodSnapshot) podFacts {
	if len(pods) == 0 {
		return podFacts{}
	}
	out := factsOf(pods[0])
	for _, p := range pods[1:] {
		f := factsOf(p)
		if f.Phase != out.Phase {
			out.Phase = ""
		}
		if f.NodeName != out.NodeName {
			out.NodeName = ""
		}
		if !samePointer(f.Security, out.Security, equalSecurity) {
			out.Security = nil
		}
		if f.PriorityClassName != out.PriorityClassName {
			out.PriorityClassName = ""
		}
		if !samePointer(f.Priority, out.Priority, func(a, b int32) bool { return a == b }) {
			out.Priority = nil
		}
		if !samePointer(f.HasImagePullSecrets, out.HasImagePullSecrets, func(a, b bool) bool { return a == b }) {
			out.HasImagePullSecrets = nil
		}
	}
	return out
}

func samePointer[T any](a, b *T, eq func(T, T) bool) bool {
	if a == nil || b == nil {
		return a == b
	}
	return eq(*a, *b)
}

func equalSecurity(a, b workloads.PodSecurity) bool {
	return a.IsolationRank == b.IsolationRank && a.RuntimeClassName == b.RuntimeClassName && a.Sandboxed == b.Sandboxed && a.User == b.User &&
		a.UserNamespace == b.UserNamespace && slices.Equal(a.Privileged, b.Privileged) && slices.Equal(a.HostNamespaces, b.HostNamespaces) && slices.Equal(a.AddedCapabilities, b.AddedCapabilities)
}

// remainder keeps only the facts a Pod does not share with its owner.
func remainder(f, owner podFacts) podFacts {
	if owner.Phase != "" {
		f.Phase = ""
	}
	if owner.NodeName != "" {
		f.NodeName = ""
	}
	if owner.Security != nil {
		f.Security = nil
	}
	if owner.PriorityClassName != "" {
		f.PriorityClassName = ""
	}
	if owner.Priority != nil {
		f.Priority = nil
	}
	if owner.HasImagePullSecrets != nil {
		f.HasImagePullSecrets = nil
	}
	return f
}

// buildInventoryTree nests Pods under the root owners that claim them.
// Finished Pods and namespace orphan buckets are left out unless requested.
func buildInventoryTree(inv *workloads.Inventory, pods []workloads.PodSnapshot, includeFinished, includeOrphans bool) *inventoryTree {
	out := &inventoryTree{Owners: []*ownerNode{}, Warnings: inv.Warnings, Revision: inv.Revision}
	byName := map[string]workloads.PodSnapshot{}
	for _, p := range pods {
		if includeFinished || !finishedPod(p) {
			byName[p.Namespace+"/"+p.Name] = p
		}
	}
	claimed := map[string]bool{}
	for _, wl := range inv.Workloads {
		if wl.Kind == "Namespace" {
			if includeOrphans {
				bucket := *wl
				bucket.StandalonePods = nil
				out.Orphans = append(out.Orphans, &bucket)
			}
			continue
		}
		owned := []workloads.PodSnapshot{}
		for _, name := range wl.Pods {
			key := wl.Namespace + "/" + name
			claimed[key] = true
			if p, ok := byName[key]; ok {
				owned = append(owned, p)
			}
		}
		node := &ownerNode{Workload: wl, podFacts: shared(owned)}
		for _, p := range owned {
			node.Pods = append(node.Pods, podNode{ScanPod: p.ScanPod, Name: p.Name, UID: p.UID, CreatedAt: p.CreatedAt, IPs: p.IPs, Containers: p.Containers, Issues: p.Issues, JobOwned: p.JobOwned, Terminating: p.Terminating, podFacts: remainder(factsOf(p), node.podFacts)})
		}
		out.Owners = append(out.Owners, node)
	}
	for _, p := range pods {
		key := p.Namespace + "/" + p.Name
		if claimed[key] {
			continue
		}
		if _, ok := byName[key]; !ok {
			continue
		}
		created := p.CreatedAt
		out.Owners = append(out.Owners, &ownerNode{
			ScanPod:    p.ScanPod,
			Workload:   &workloads.Workload{Kind: "Pod", APIVersion: "v1", Name: p.Name, Namespace: p.Namespace, UID: p.UID, CreatedAt: &created, Issues: p.Issues},
			podFacts:   factsOf(p),
			IPs:        p.IPs,
			Containers: p.Containers,
		})
	}
	return out
}
