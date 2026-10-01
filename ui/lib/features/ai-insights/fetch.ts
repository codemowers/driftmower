import { WORKLOADS_URL } from "@/lib/cluster/constants"
import { normalizeAiInsights } from "./parse"
import type { AiInsights, WorkloadsResponse } from "./types"

const cache = new Map<string, AiInsights | null>()

export async function fetchAiInsights(
  workloadKey: string,
  reportId: string,
): Promise<AiInsights | null> {
  const cacheKey = `${reportId}|${workloadKey}`
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null

  const params = new URLSearchParams({ workloadKey, reportId, $limit: "1" })
  const res = await fetch(`${WORKLOADS_URL}?${params}`, { cache: "no-store" })
  if (!res.ok) throw new Error(`Failed to fetch workload insights: ${res.status}`)
  const json: WorkloadsResponse = await res.json()
  const raw = json.data[0]?.aiInsights
  const insights = raw ? normalizeAiInsights(JSON.parse(raw)) : null

  cache.set(cacheKey, insights)
  return insights
}
