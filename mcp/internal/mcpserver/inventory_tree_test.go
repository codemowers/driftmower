package mcpserver

import (
	"testing"

	"github.com/codemowers/driftmower/mcp/internal/workloads"
)

func TestInventoryTreeHoistsSharedPodFacts(t *testing.T) {
	security := &workloads.PodSecurity{User: "nonroot"}
	pod := func(name, phase, node string) workloads.PodSnapshot {
		return workloads.PodSnapshot{Name: name, Namespace: "team", UID: name, Phase: phase, NodeName: node, Security: security, Containers: []workloads.PodContainer{{Name: "app", Image: "app:1"}}}
	}
	inv := &workloads.Inventory{Workloads: []*workloads.Workload{
		{Kind: "Deployment", Name: "web", Namespace: "team", UID: "d", Dependencies: workloads.Dependencies{Pods: []string{"web-a", "web-b", "web-done"}}},
		{Kind: "Namespace", Name: "orphaned-workloads", Namespace: "team", UID: "namespace:team"},
	}}
	pods := []workloads.PodSnapshot{pod("web-a", "Running", "n1"), pod("web-b", "Running", "n2"), pod("web-done", "Succeeded", "n1"), pod("debug", "Running", "n3")}

	tree := buildInventoryTree(inv, pods, false, false)
	if len(tree.Owners) != 2 || tree.Orphans != nil {
		t.Fatalf("owners = %d, orphans = %v", len(tree.Owners), tree.Orphans)
	}
	web := tree.Owners[0]
	if len(web.Pods) != 2 || web.Phase != "Running" || web.Security != security || web.NodeName != "" {
		t.Fatalf("web = %+v", web.podFacts)
	}
	if web.Pods[0].Phase != "" || web.Pods[0].Security != nil || web.Pods[0].NodeName != "n1" || len(web.Pods[0].Containers) != 1 {
		t.Fatalf("pod keeps only what it does not share: %+v", web.Pods[0])
	}
	if standalone := tree.Owners[1]; standalone.Kind != "Pod" || standalone.Name != "debug" || standalone.Pods != nil || standalone.NodeName != "n3" || len(standalone.Containers) != 1 {
		t.Fatalf("standalone = %+v", standalone)
	}

	all := buildInventoryTree(inv, pods, true, true)
	if len(all.Owners[0].Pods) != 3 || all.Owners[0].Phase != "" || len(all.Orphans) != 1 {
		t.Fatalf("finished Pods and orphans on request: %+v", all.Owners[0].podFacts)
	}
}

func TestInventoryTreePreservesScanMarkersForOwnedAndStandalonePods(t *testing.T) {
	inv := &workloads.Inventory{Workloads: []*workloads.Workload{{Kind: "ContainerImage", Name: "image", Namespace: "team", Dependencies: workloads.Dependencies{Pods: []string{"failed-scan"}}}}}
	pods := []workloads.PodSnapshot{{Name: "failed-scan", Namespace: "team", ScanPod: true, Phase: "Failed"}, {Name: "standalone", Namespace: "team", ScanPod: true, Phase: "Running"}}
	tree := buildInventoryTree(inv, pods, true, false)
	if len(tree.Owners) != 2 || len(tree.Owners[0].Pods) != 1 || !tree.Owners[0].Pods[0].ScanPod || !tree.Owners[1].ScanPod {
		t.Fatalf("scan marker lost: %+v", tree)
	}
}
