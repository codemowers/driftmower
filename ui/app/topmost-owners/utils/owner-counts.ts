import type { ClusterResource } from "@/lib/cluster/cluster-state"
import type { Report } from "@/lib/cluster/reports"
import { liveWorkloadEntries } from "./live-entries"
import { reportWorkloadRoots } from "./report-roots"

export function countTopmostOwners(
  data: Report | null,
  clusterResources: ClusterResource[] | null,
  namespaces?: Set<string> | null,
): { tracked: number; total: number } {
  const allRoots = reportWorkloadRoots(data)
  const roots = namespaces ? allRoots.filter(r => namespaces.has(r.namespace)) : allRoots
  const liveEntries = liveWorkloadEntries(
    clusterResources,
    new Map(),
    new Set(allRoots.map(r => r.uid)),
    new Set(allRoots.map(r => r.groupKey)),
  ).filter(e => !namespaces || namespaces.has(e.namespace))
  return { tracked: roots.length, total: roots.length + liveEntries.length }
}
