import type { ImageUsage, Issue, Report, ScrapeStatus, StatusType } from "@/lib/cluster/reports"
import { SEVERITY_ORDER } from "@/lib/cluster/styles/status-style"
import { resolvedVersion } from "@/lib/utils/image-artifacts"
import { sourceRepoUrl } from "@/lib/utils/oci-labels"

export type ImageWorkload = {
  uid: string
  name: string
  namespace: string
}

export type ImageEntry = {
  key: string
  registry: string
  repository: string
  runningTags: string[]
  versionCount: number
  latestTag: string | null
  worstStatus: StatusType
  workloads: ImageWorkload[]
  containerCount: number
  digests: string[]
  issueCount: number
  sourceUrl: string | null
}

export type ImageVersion = {
  artifactKey: string
  digest: string | null
  tag: string | null
  resolvedTag: string | null
  tagStatus: string
  statusType: StatusType
  containerCount: number
  workloadCount: number
  usage: ImageUsage
}

export type ImageRelease = {
  uid: string
  name: string
  chartName: string
  chartVersion: string
  revision?: number
}

export type ImageWorkloadRow = ImageWorkload & {
  kind: string
  containerCount: number
  versions: string[]
}

export type ImageDetail = ImageEntry & {
  versions: ImageVersion[]
  namespaceCount: number
  releases: ImageRelease[]
  workloadRows: ImageWorkloadRow[]
  issues: Issue[]
}

function present(value: string | null | undefined): value is string {
  return Boolean(value)
}

function artifactKey(usage: ImageUsage): string {
  return usage.imageInfo.digest || usage.imageId || usage.image
}

function matchingIssues(key: string, usages: ImageUsage[], issues: Issue[]): Issue[] {
  return issues.filter(i => i.image === key || usages.some(u => u.image.includes(i.image)))
}

function toEntry(key: string, usages: ImageUsage[], issues: Report["issues"]): ImageEntry {
  const { registry, repository } = usages[0].imageInfo

  const workloads: ImageWorkload[] = []
  const seenWorkloads = new Set<string>()
  for (const usage of usages) {
    const root = usage.workloadRootInfo
    if (!root?.uid || seenWorkloads.has(root.groupKey)) continue
    seenWorkloads.add(root.groupKey)
    workloads.push({ uid: root.uid, name: root.name, namespace: root.namespace })
  }

  const worstStatus = usages.reduce<StatusType>((worst, usage) => {
    const status = usage.versionStatus.statusType
    return SEVERITY_ORDER[status] > SEVERITY_ORDER[worst] ? status : worst
  }, "no_data")

  return {
    key,
    registry,
    repository,
    runningTags: [...new Set(usages.map(u => u.versionStatus.deployedTag ?? u.imageInfo.tag).filter(present))].sort(),
    versionCount: new Set(usages.map(artifactKey)).size,
    latestTag: usages.map(u => u.versionStatus.latestTag).find(present) ?? null,
    worstStatus,
    workloads,
    containerCount: usages.length,
    digests: [...new Set(usages.map(u => u.imageInfo.digest).filter(present))],
    issueCount: matchingIssues(key, usages, issues).length,
    sourceUrl: usages.map(u => u.imageInfo.crawlerSource?.url ?? sourceRepoUrl(u.imageInfo.labels) ?? u.imageInfo.sourceRepositories?.[0]?.url).find(present) ?? null,
  }
}

function groupUsagesByRepo(data: Report, scopeNamespaces: Set<string> | null): Map<string, ImageUsage[]> {
  const grouped = new Map<string, ImageUsage[]>()
  for (const usage of data.report.imageUsages) {
    if (scopeNamespaces && !scopeNamespaces.has(usage.namespace)) continue
    const { registry, repository } = usage.imageInfo
    if (!registry || !repository) continue
    const key = `${registry}/${repository}`
    const existing = grouped.get(key)
    if (existing) existing.push(usage)
    else grouped.set(key, [usage])
  }
  return grouped
}

export function imageEntries(data: Report | null, scopeNamespaces: Set<string> | null): ImageEntry[] {
  if (!data) return []
  return [...groupUsagesByRepo(data, scopeNamespaces)].map(([key, usages]) => toEntry(key, usages, data.issues))
}

function toVersions(usages: ImageUsage[]): ImageVersion[] {
  const grouped = new Map<string, ImageUsage[]>()
  for (const usage of usages) {
    const key = artifactKey(usage)
    const existing = grouped.get(key)
    if (existing) existing.push(usage)
    else grouped.set(key, [usage])
  }

  return [...grouped]
    .map(([key, versionUsages]): ImageVersion => {
      const usage = versionUsages[0]
      return {
        artifactKey: key,
        digest: usage.imageInfo.digest || null,
        tag: usage.versionStatus.deployedTag ?? usage.imageInfo.tag ?? null,
        resolvedTag: resolvedVersion(usage),
        tagStatus: usage.tagStatus,
        statusType: usage.versionStatus.statusType,
        containerCount: versionUsages.length,
        workloadCount: new Set(versionUsages.map(u => u.workloadRootInfo?.groupKey).filter(present)).size,
        usage,
      }
    })
    .sort((a, b) => SEVERITY_ORDER[b.statusType] - SEVERITY_ORDER[a.statusType] || b.containerCount - a.containerCount)
}

function toWorkloadRows(usages: ImageUsage[]): ImageWorkloadRow[] {
  const rows = new Map<string, ImageWorkloadRow>()
  const versions = new Map<string, Set<string>>()
  for (const usage of usages) {
    const root = usage.workloadRootInfo
    if (!root?.uid) continue

    const resolved = resolvedVersion(usage)
    if (resolved) {
      const seen = versions.get(root.groupKey)
      if (seen) seen.add(resolved)
      else versions.set(root.groupKey, new Set([resolved]))
    }

    const existing = rows.get(root.groupKey)
    if (existing) {
      existing.containerCount++
      continue
    }
    rows.set(root.groupKey, {
      uid: root.uid,
      kind: root.qualifiedKind ?? root.kind,
      name: root.name,
      namespace: root.namespace,
      containerCount: 1,
      versions: [],
    })
  }

  for (const [groupKey, row] of rows) {
    row.versions = [...(versions.get(groupKey) ?? [])].sort()
  }
  return [...rows.values()].sort((a, b) => b.containerCount - a.containerCount || a.name.localeCompare(b.name))
}

function toReleases(usages: ImageUsage[], data: Report): ImageRelease[] {
  const releases = new Map<string, ImageRelease>()
  for (const usage of usages) {
    const info = usage.releaseInfo
    if (info?.managementKind !== "helm" || releases.has(info.groupKey)) continue
    // info.uid mirrors the workload; /helm-releases/[uid] needs the release's own.
    const uid = data.rotenness.releaseScores[info.groupKey]?.releaseInfo.uid
    if (!uid) continue
    releases.set(info.groupKey, {
      uid,
      name: info.name,
      chartName: info.chartName,
      chartVersion: info.chartVersion,
      revision: info.revision,
    })
  }
  return [...releases.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export type TagResolution = {
  considered: string[]
  offChannel: string[]
  availableCount: number
  latest: string | null
  scrape?: ScrapeStatus
}

// No maps at all means the backend omits them, not that the scrape failed.
export function tagResolution(data: Report | null, key: string): TagResolution | null {
  const report = data?.report
  if (!report) return null

  const maps = [report.consideredTagsMap, report.availableTagsMap, report.irrelevantTagsMap]
  if (maps.every(map => map === undefined)) return null

  return {
    considered: report.consideredTagsMap?.[key] ?? [],
    offChannel: report.irrelevantTagsMap?.[key] ?? [],
    availableCount: (report.availableTagsMap?.[key] ?? []).length,
    latest: report.latestSemverMap?.[key] ?? null,
    scrape: report.scrapeStatusMap?.[key],
  }
}

export function imageUsagesForKey(data: Report | null, key: string, scopeNamespaces: Set<string> | null): ImageUsage[] {
  if (!data) return []
  return groupUsagesByRepo(data, scopeNamespaces).get(key) ?? []
}

export function imageDetail(
  data: Report | null,
  key: string,
  scopeNamespaces: Set<string> | null,
): ImageDetail | null {
  if (!data) return null
  const usages = imageUsagesForKey(data, key, scopeNamespaces)
  if (usages.length === 0) return null

  return {
    ...toEntry(key, usages, data.issues),
    versions: toVersions(usages),
    namespaceCount: new Set(usages.map(u => u.namespace)).size,
    releases: toReleases(usages, data),
    workloadRows: toWorkloadRows(usages),
    issues: matchingIssues(key, usages, data.issues),
  }
}
