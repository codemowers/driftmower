import type { Report } from "@/lib/cluster/reports"
import type { ClusterResource } from "@/lib/cluster/cluster-state"
import type { VulnerabilityReport } from "@/lib/features/vulnerability/types"
import { ACTIONS_ASSESS_URL } from "@/lib/cluster/constants"
import { readApiError } from "@/lib/utils/read-api-error"
import { deriveClusterActions } from "./derive"
import type { ActionFacts, ActionRow, AssessResponse, AssessState } from "./types"

export const MAX_ACTIONS_PER_REQUEST = 500

export type AssessOutcome = AssessResponse | { unavailable: string }

const known = new Map<string, AssessState>()

export function rememberResults(results: Record<string, AssessState>): void {
  for (const [key, state] of Object.entries(results)) known.set(key, state)
}

export function recallResults(rows: ActionRow[]): Record<string, AssessState> {
  const results: Record<string, AssessState> = {}
  for (const row of rows) {
    const state = known.get(row.key)
    if (state) results[row.key] = state
  }
  return results
}

export async function postAssess(actions: ActionFacts[], focus: boolean): Promise<AssessOutcome> {
  const res = await fetch(ACTIONS_ASSESS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ focus, actions }),
    cache: "no-store",
  })
  if (res.status === 401 || res.status === 503) return { unavailable: await readApiError(res) }
  if (!res.ok) throw new Error(await readApiError(res))
  return (await res.json()) as AssessResponse
}

export async function postAssessAll(actions: ActionFacts[], focus: boolean): Promise<AssessOutcome> {
  const merged: AssessResponse = { results: {} }
  for (let i = 0; i < actions.length; i += MAX_ACTIONS_PER_REQUEST) {
    const outcome = await postAssess(actions.slice(i, i + MAX_ACTIONS_PER_REQUEST), focus)
    if ("unavailable" in outcome) return outcome
    Object.assign(merged.results, outcome.results)
  }
  return merged
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
  const actions = deriveClusterActions(data, clusterResources, vulnReports, null).map(row => row.facts)
  if (actions.length === 0) return
  void postAssessAll(actions, false)
    .then(outcome => "results" in outcome && rememberResults(outcome.results))
    .catch(() => prewarmed.delete(reportId))
}
