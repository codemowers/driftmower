import type { ClusterResource } from "@/lib/cluster/cluster-state"
import type { Report } from "@/lib/cluster/reports"
import { liveWorkloadEntries } from "./live-entries"
import { reportWorkloadRoots } from "./report-roots"

export function countTopmostOwners(
  data: Report | null,
  clusterResources: ClusterResource[] | null,
): { tracked: number; total: number } {
  const roots = reportWorkloadRoots(data)
  const liveCount = liveWorkloadEntries(
    clusterResources,
    new Map(),
    new Set(roots.map(r => r.uid)),
    new Set(roots.map(r => r.groupKey)),
  ).length
  return { tracked: roots.length, total: roots.length + liveCount }
}
