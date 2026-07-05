import type { ClusterResource } from "@/lib/cluster/cluster-state"
import { classifyPod, podStateLabel, POD_SQUARE_ORDER, type PodSeverity } from "@/lib/cluster/pod-status-style"

export type PodSummary = {
  total: number
  counts: Record<PodSeverity, number>
  worst: { severity: PodSeverity; display: string }
  restarts: number
}

export const EMPTY_POD_SUMMARY: PodSummary = {
  total: 0,
  counts: { failed: 0, unknown: 0, pending: 0, healthy: 0, succeeded: 0 },
  worst: { severity: "healthy", display: "Healthy" },
  restarts: 0,
}

export function summarizePodsByRoot(resources: ClusterResource[] | null): Map<string, PodSummary> {
  const summaries = new Map<string, PodSummary>()
  if (!resources) return summaries

  const byUid = new Map(resources.map(r => [r.uid, r]))
  const rootOf = new Map<string, string>()

  function resolveRoot(uid: string): string {
    const walked: string[] = []
    let current = uid
    while (!rootOf.has(current)) {
      walked.push(current)
      const ownerUID = byUid.get(current)?.ownerUID
      if (!ownerUID || !byUid.has(ownerUID) || walked.includes(ownerUID)) break
      current = ownerUID
    }
    const root = rootOf.get(current) ?? current
    for (const step of walked) rootOf.set(step, root)
    return root
  }

  const displayBySeverity = new Map<string, Partial<Record<PodSeverity, string>>>()

  for (const resource of resources) {
    if (resource.kind !== "Pod") continue
    const root = resolveRoot(resource.uid)
    const severity = classifyPod(resource)

    const summary = summaries.get(root) ?? {
      total: 0,
      counts: { failed: 0, unknown: 0, pending: 0, healthy: 0, succeeded: 0 },
      worst: { severity: "healthy" as PodSeverity, display: "Healthy" },
      restarts: 0,
    }
    summary.total++
    summary.counts[severity]++
    summary.restarts += resource.podStatus?.restarts ?? 0
    summaries.set(root, summary)

    const displays = displayBySeverity.get(root) ?? {}
    displays[severity] ??= resource.podStatus?.display ?? resource.phase ?? "Unknown"
    displayBySeverity.set(root, displays)
  }

  for (const [root, summary] of summaries) {
    const severity = POD_SQUARE_ORDER.find(s => summary.counts[s] > 0) ?? "healthy"
    summary.worst = { severity, display: podStateLabel(severity, displayBySeverity.get(root)?.[severity]) }
  }

  return summaries
}
