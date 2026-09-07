import type { Report } from "@/lib/cluster/reports"
import type { ClusterResource } from "@/lib/cluster/cluster-state"
import type { VulnerabilityReport } from "@/lib/features/vulnerability/types"
import { ACTIONS_ASSESS_URL } from "@/lib/cluster/constants"
import { findWorkloadRoot } from "@/lib/cluster/workload-root"
import { deriveActions } from "./derive"
import type { ActionFacts, AssessResponse } from "./types"

export type AssessOutcome = AssessResponse | "unavailable"

export async function postAssess(actions: ActionFacts[], focus: boolean): Promise<AssessOutcome> {
  const res = await fetch(ACTIONS_ASSESS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ focus, actions }),
    cache: "no-store",
  })
  if (res.status === 401 || res.status === 503) return "unavailable"
  if (!res.ok) throw new Error(`assess ${res.status}`)
  return (await res.json()) as AssessResponse
}

const prewarmed = new Set<string>()

export function prewarmActions(
  reportId: string,
  data: Report,
  clusterResources: ClusterResource[] | null,
  vulnReports: Record<string, VulnerabilityReport> | null,
): void {
  if (prewarmed.has(reportId)) return
  prewarmed.add(reportId)
  const actions: ActionFacts[] = []
  for (const usages of Object.values(data.report.workloadGroupMap)) {
    const info = usages[0]?.workloadRootInfo
    if (!info?.uid) continue
    const root = findWorkloadRoot(clusterResources, info)
    for (const row of deriveActions(usages, root, vulnReports)) actions.push(row.facts)
  }
  if (actions.length === 0) return
  void postAssess(actions, false).catch(() => prewarmed.delete(reportId))
}
