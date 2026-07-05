import type { ClusterResource } from "@/lib/cluster/cluster-state"
import type { WorkloadEntry } from "../focus/types"
import { EMPTY_POD_SUMMARY, type PodSummary } from "./pod-summary"

export function liveWorkloadEntries(
  clusterResources: ClusterResource[] | null,
  podSummaries: Map<string, PodSummary>,
  excludeUids: Set<string>,
  excludeGroupKeys: Set<string>,
): WorkloadEntry[] {
  if (!clusterResources) return []

  const entries: WorkloadEntry[] = []
  for (const resource of clusterResources) {
    if (resource.ownerUID) continue
    const groupKey = `${resource.kind}/${resource.namespace}/${resource.name}`
    if (excludeUids.has(resource.uid) || excludeGroupKeys.has(groupKey)) continue

    entries.push({
      groupKey,
      uid: resource.uid,
      kind: resource.kind,
      name: resource.name,
      namespace: resource.namespace,
      manager: managerFor(resource),
      worstStatus: "no_data",
      issueCount: 0,
      inReport: false,
      pods: podSummaries.get(resource.uid) ?? EMPTY_POD_SUMMARY,
    })
  }
  return entries
}

function managerFor(resource: ClusterResource): WorkloadEntry["manager"] {
  if (resource.argoApp) {
    return { kind: "argo", name: resource.argoApp.name, url: resource.argoApp.url }
  }
  if (resource.managerUID?.startsWith("helm-release:")) {
    const releaseName = resource.managerUID.split(":")[2]
    if (releaseName) return { kind: "helm", name: releaseName }
  }
  return { kind: "standalone" }
}
