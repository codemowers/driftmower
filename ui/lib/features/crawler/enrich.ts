import type { SourceScrape } from "./sources.ts"
import type { ImageUsage, StatusType } from "../../cluster/reports"
import type { DashboardSnapshot } from "../../../browser/snapshot"

export type SourceSummary = SourceScrape & { url: string; deployed: { version: string; images: string[]; references?: string[]; versionStatus: ImageUsage["versionStatus"] }[] }

// Match immutable running digests before tags, including Docker Hub aliases.
export function referenceKeys(ref: string): string[] {
  const [raw, digest] = ref.trim().split("@")
  let name = raw, tag = "latest", explicit = false
  const colon = name.lastIndexOf(":")
  if (colon > name.lastIndexOf("/")) { tag = name.slice(colon + 1); name = name.slice(0, colon); explicit = true }
  let [host, ...parts] = name.toLowerCase().split("/")
  if (!parts.length || (!/[.:]/.test(host) && host !== "localhost")) { parts = name.toLowerCase().split("/"); host = "docker.io" }
  if (["index.docker.io", "registry-1.docker.io"].includes(host)) host = "docker.io"
  if (host === "docker.io" && parts.length === 1) parts.unshift("library")
  const repo = `${host}/${parts.join("/")}`
  return digest ? [`${repo}@${digest}`, ...(explicit ? [`${repo}:${tag}`] : [])] : [`${repo}:${tag}`]
}

const weights: Partial<Record<StatusType, number>> = { up_to_date: 0, ahead: 0, patch_behind: 1 / 3, minor_behind: 2 / 3, major_behind: 1, behind: .5 }
function score(items: ImageUsage[]) {
  const repos = new Map<string, number>()
  for (const item of items) {
    if ((item as ImageUsage & { finished?: boolean }).finished) continue
    const weight = weights[item.versionStatus.statusType]
    if (weight === undefined) continue
    const repo = `${item.imageInfo.registry}/${item.imageInfo.repository}`
    repos.set(repo, Math.max(repos.get(repo) ?? 0, weight))
  }
  const values = [...repos.values()]
  return { normalizedScore: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0, distinctRepoCount: values.length, staleRepoCount: values.filter(v => v > 0).length }
}

export function enrichSnapshot(snapshot: DashboardSnapshot, sources: SourceSummary[]): DashboardSnapshot {
  const index = new Map<string, { source: SourceSummary; deployed: SourceSummary["deployed"][number] }>()
  for (const source of sources) for (const deployed of source.deployed) for (const ref of [...deployed.images, ...(deployed.references ?? [])]) for (const key of referenceKeys(ref)) index.set(key, { source, deployed })
  for (const usage of snapshot.imageUsages) {
    const info = usage.imageInfo
    const ref = info.digest ? `${info.registry}/${info.repository}@${info.digest}` : usage.image
    const keys = referenceKeys(ref)
    const match = (info.digest ? keys.slice(0, 1) : keys).map(k => index.get(k)).find(Boolean)
    if (match) {
      usage.versionStatus = match.deployed.versionStatus
      info.crawlerSource = { url: match.source.url, version: match.deployed.version }
      info.sourceStatus = "linked"
    }
  }
  // Presentation groups share the enriched usage references.
  snapshot.workloadGroups = {}; snapshot.releaseGroups = {}
  for (const usage of snapshot.imageUsages) {
    const group = usage.workloadRootInfo?.groupKey
    if (group) (snapshot.workloadGroups[group] ??= []).push(usage)
    if (usage.releaseInfo) (snapshot.releaseGroups[usage.releaseInfo.groupKey] ??= []).push(usage)
  }
  let sum = 0, count = 0
  for (const [groupKey, items] of Object.entries(snapshot.workloadGroups)) {
    const stats = score(items); sum += stats.normalizedScore * stats.distinctRepoCount; count += stats.distinctRepoCount
    snapshot.drift.workloadScores[groupKey] = { ...stats, groupKey, workloadRootInfo: items[0].workloadRootInfo!, totalContainers: items.filter(i => !(i as ImageUsage & { finished?: boolean }).finished).length }
  }
  for (const [groupKey, items] of Object.entries(snapshot.releaseGroups)) {
    snapshot.drift.releaseScores[groupKey] = { ...snapshot.drift.releaseScores[groupKey], ...score(items) }
  }
  snapshot.drift.normalizedScore = count ? sum / count : 0
  return snapshot
}
