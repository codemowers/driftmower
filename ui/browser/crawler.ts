import { sourceFindings } from "./catalog"
import { enrichSnapshot, type SourceSummary } from "../lib/features/crawler/enrich.ts"
import type { DashboardSnapshot } from "./snapshot"

export async function loadCrawlerFindings(snapshot: DashboardSnapshot): Promise<DashboardSnapshot> {
  try {
    const data = await sourceFindings<{ sources: SourceSummary[]; missing?: string[] }>({summary:"true"})
    if (data.missing?.length) snapshot.missingComponents = [...new Set([...(snapshot.missingComponents ?? []), "nodestatd"])]
    return enrichSnapshot(snapshot, data.sources)
  } catch (error) {
    snapshot.warnings = [...(snapshot.warnings ?? []), `Crawler findings unavailable: ${error instanceof Error ? error.message : String(error)}`]
    return snapshot
  }
}
