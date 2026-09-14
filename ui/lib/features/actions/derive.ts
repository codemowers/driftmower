import type { ImageUsage, ReleaseInfo, Report, StatusType } from "@/lib/cluster/reports"
import type { ClusterResource } from "@/lib/cluster/cluster-state"
import type { VulnerabilityReport } from "@/lib/features/vulnerability/types"
import { SEVERITY_ORDER } from "@/lib/cluster/styles/status-style"
import { findWorkloadRoot } from "@/lib/cluster/workload-root"
import { resolvedVersion } from "@/lib/utils/image-artifacts"
import { sourceRepoUrl } from "@/lib/utils/oci-labels"
import { compareChartVersions } from "@/lib/features/helm-releases/chart-versions"
import { compareSemver, parseSemver, severeFixableCount } from "./verdict"
import type { LivePatchUpgradeTarget } from "@/lib/features/live-patch-upgrade/types"
import {
  assessKey,
  managerScope,
  type ActionFacts,
  type ActionRow,
  type AssessResult,
  type AssessState,
  type ClusterActionRow,
  type CveFact,
  type DisplayRow,
  type DriftClass,
  type HowCommand,
  type ManagerFacts,
  type Relation,
} from "./types"

const BEHIND: StatusType[] = ["patch_behind", "minor_behind", "major_behind"]
const BUILTIN_API_GROUPS = new Set(["", "apps", "batch", "v1", "core"])
const CVE_CAP = 40
const KIND_ORDER: Record<ActionFacts["kind"], number> = { "update-image": 0, "upgrade-chart": 1, "pin-digest": 2 }
const DRIFT_RANK: Record<DriftClass, number> = { major: 0, minor: 1, patch: 2, unknown: 3 }

export function managerFacts(usages: ImageUsage[], root: ClusterResource | undefined, container: string): ManagerFacts {
  const first = usages[0]
  const release = first?.releaseInfo
  if (release?.managementKind === "helm") {
    return {
      kind: "helm",
      namespace: release.namespace,
      release: release.name,
      chartSource: release.chartSource,
      chartRepoUrl: release.chartRepoUrl,
      chartVersion: release.chartVersion,
    }
  }
  if (root?.argoApp) return { kind: "argo", app: root.argoApp.name, url: root.argoApp.detailsUrl ?? root.argoApp.url }
  const info = first?.workloadRootInfo
  const workloadKind = info?.kind ?? root?.kind ?? "Deployment"
  const namespace = info?.namespace ?? root?.namespace ?? first?.namespace ?? ""
  const name = info?.name ?? root?.name ?? ""
  const apiGroup = info?.apiGroup ?? ""
  if (!BUILTIN_API_GROUPS.has(apiGroup)) return { kind: "operator", workloadKind, apiGroup, namespace, name }
  return { kind: "standalone", workloadKind, namespace, name, container }
}

function driftClass(usage: ImageUsage): DriftClass {
  switch (usage.versionStatus.statusType) {
    case "patch_behind":
      return "patch"
    case "minor_behind":
      return "minor"
    case "major_behind":
      return "major"
    default:
      return "unknown"
  }
}

function cveFacts(usage: ImageUsage, vulnReports: Record<string, VulnerabilityReport> | null): CveFact[] {
  const report = vulnReports?.[usage.imageInfo.digest]
  if (!report) return []
  const seen = new Set<string>()
  const facts: CveFact[] = []
  for (const v of report.report.vulnerabilities) {
    if (seen.has(v.vulnerabilityID)) continue
    seen.add(v.vulnerabilityID)
    facts.push({ id: v.vulnerabilityID, severity: v.severity, fixedVersion: v.fixedVersion || null })
  }
  facts.sort((a, b) => Number(Boolean(b.fixedVersion)) - Number(Boolean(a.fixedVersion)))
  return facts.slice(0, CVE_CAP)
}

function livePatchUpgradeTarget(usage: ImageUsage): LivePatchUpgradeTarget | undefined {
  const info = usage.workloadRootInfo
  if (!info) return undefined
  return { namespace: info.namespace, kind: info.kind, name: info.name, uid: info.uid }
}

function shortName(repository: string): string {
  return repository.split("/").pop() ?? repository
}

function worstUsagePerRepo(usages: ImageUsage[]): Map<string, ImageUsage> {
  const byRepo = new Map<string, ImageUsage>()
  for (const usage of usages) {
    const repo = `${usage.imageInfo.registry}/${usage.imageInfo.repository}`
    const prev = byRepo.get(repo)
    if (!prev || SEVERITY_ORDER[usage.versionStatus.statusType] > SEVERITY_ORDER[prev.versionStatus.statusType]) {
      byRepo.set(repo, usage)
    }
  }
  return byRepo
}

function imageRows(repository: string, usage: ImageUsage, manager: ManagerFacts, vulnReports: Record<string, VulnerabilityReport> | null): ActionRow[] {
  const rows: ActionRow[] = []
  const from = resolvedVersion(usage)
  const to = usage.versionStatus.latestTag
  if (BEHIND.includes(usage.versionStatus.statusType) && from && to && from !== to) {
    const facts: ActionFacts = {
      kind: "update-image",
      repository,
      from,
      to,
      drift: driftClass(usage),
      sourceRepoUrl: sourceRepoUrl(usage.imageInfo.labels),
      cves: cveFacts(usage, vulnReports),
      manager,
    }
    rows.push({ key: assessKey(facts), facts, verb: "Update image", name: shortName(repository), statusType: usage.versionStatus.statusType, target: livePatchUpgradeTarget(usage) })
  }
  if (usage.tagStatus === "mismatch" && from) {
    const facts: ActionFacts = {
      kind: "pin-digest",
      repository,
      from: usage.imageInfo.tag,
      to: from,
      drift: "unknown",
      sourceRepoUrl: null,
      cves: [],
      manager,
      digest: usage.imageInfo.digest,
    }
    rows.push({ key: assessKey(facts), facts, verb: "Pin the digest", name: shortName(repository), statusType: usage.versionStatus.statusType })
  }
  return rows
}

function chartRow(release: ReleaseInfo | null, manager: ManagerFacts): ActionRow | null {
  if (release?.managementKind !== "helm" || !release.latestChartTag) return null
  if (compareChartVersions(release.latestChartTag, release.chartVersion) <= 0) return null
  const facts: ActionFacts = {
    kind: "upgrade-chart",
    repository: `${release.chartRepoUrl ?? release.chartSource ?? "chart"}/${release.chartName}`,
    from: release.chartVersion,
    to: release.latestChartTag,
    drift: chartDrift(release.chartVersion, release.latestChartTag),
    sourceRepoUrl: null,
    cves: [],
    manager,
    chart: { name: release.chartName, repoUrl: release.chartRepoUrl, source: release.chartSource },
  }
  return { key: assessKey(facts), facts, verb: "Upgrade chart", name: release.chartName, statusType: "no_data" }
}

function ownerLabel(manager: ManagerFacts): string {
  switch (manager.kind) {
    case "helm":
      return `release ${manager.release}`
    case "argo":
      return `app ${manager.app}`
    default:
      return `${manager.workloadKind} ${manager.namespace}/${manager.name}`
  }
}

function repositoryKey(usage: ImageUsage): string {
  return `${usage.imageInfo.registry}/${usage.imageInfo.repository}`
}

export function deriveActions(
  usages: ImageUsage[],
  root: ClusterResource | undefined,
  vulnReports: Record<string, VulnerabilityReport> | null,
): ActionRow[] {
  const rows: ActionRow[] = []
  for (const [repository, usage] of worstUsagePerRepo(usages)) {
    rows.push(...imageRows(repository, usage, managerFacts(usages, root, usage.containerName), vulnReports))
  }
  const first = usages[0]
  const chart = first ? chartRow(first.releaseInfo, managerFacts(usages, root, first.containerName)) : null
  if (chart) rows.push(chart)
  return rows.sort(compareActionRows)
}

export function deriveImageActions(
  usages: ImageUsage[],
  clusterResources: ClusterResource[] | null,
  vulnReports: Record<string, VulnerabilityReport> | null,
): ActionRow[] {
  const roots = new Map<string, ClusterResource | undefined>()
  const rootFor = (usage: ImageUsage): ClusterResource | undefined => {
    const info = usage.workloadRootInfo
    if (!info) return undefined
    if (!roots.has(info.groupKey)) roots.set(info.groupKey, findWorkloadRoot(clusterResources, info))
    return roots.get(info.groupKey)
  }

  const byKey = new Map<string, ActionRow>()
  const chartScopes = new Set<string>()
  for (const usage of usages) {
    const manager = managerFacts([usage], rootFor(usage), usage.containerName)
    const name = ownerLabel(manager)
    for (const row of imageRows(repositoryKey(usage), usage, manager, vulnReports)) {
      if (!byKey.has(row.key)) byKey.set(row.key, { ...row, name })
    }
    if (manager.kind !== "helm" || chartScopes.has(managerScope(manager))) continue
    chartScopes.add(managerScope(manager))
    const chart = chartRow(usage.releaseInfo, manager)
    if (chart) byKey.set(chart.key, { ...chart, name })
  }
  return [...byKey.values()].sort(compareActionRows)
}

export function deriveClusterActions(
  data: Report,
  clusterResources: ClusterResource[] | null,
  vulnReports: Record<string, VulnerabilityReport> | null,
  scopeNamespaces: ReadonlySet<string> | null,
): ClusterActionRow[] {
  const byKey = new Map<string, ClusterActionRow>()
  for (const usages of Object.values(data.report.workloadGroupMap)) {
    const first = usages[0]
    const info = first?.workloadRootInfo
    if (!info?.uid) continue
    if (scopeNamespaces && !scopeNamespaces.has(first.namespace)) continue
    const root = findWorkloadRoot(clusterResources, info)
    const releaseGroup = first.releaseInfo?.managementKind === "helm" ? first.releaseInfo.groupKey : null
    const releaseUid = releaseGroup ? data.rotenness.releaseScores[releaseGroup]?.releaseInfo.uid ?? null : null
    const owner = { uid: info.uid, kind: info.kind, name: info.name, namespace: info.namespace }
    for (const row of deriveActions(usages, root, vulnReports)) {
      if (!byKey.has(row.key)) byKey.set(row.key, { ...row, owner, releaseUid })
    }
  }
  return [...byKey.values()].sort(compareActionFacts)
}

export function compareActionFacts(a: ActionRow, b: ActionRow): number {
  return (
    severeFixableCount(b.facts) - severeFixableCount(a.facts) ||
    DRIFT_RANK[a.facts.drift] - DRIFT_RANK[b.facts.drift] ||
    KIND_ORDER[a.facts.kind] - KIND_ORDER[b.facts.kind] ||
    a.name.localeCompare(b.name)
  )
}

export function currentChartScopes(usages: ImageUsage[]): Set<string> {
  const scopes = new Set<string>()
  for (const usage of usages) {
    const release = usage.releaseInfo
    if (release?.managementKind !== "helm" || !release.latestChartTag) continue
    if (compareChartVersions(release.latestChartTag, release.chartVersion) > 0) continue
    scopes.add(managerScope({ kind: "helm", namespace: release.namespace, release: release.name, chartVersion: release.chartVersion }))
  }
  return scopes
}

function chartDrift(from: string, to: string): DriftClass {
  const a = from.replace(/^v/, "").split(".").map(Number)
  const b = to.replace(/^v/, "").split(".").map(Number)
  if (a[0] !== b[0]) return "major"
  if (a[1] !== b[1]) return "minor"
  return "patch"
}

function semverEqual(a: string, b: string): boolean {
  const x = parseSemver(a)
  const y = parseSemver(b)
  return x !== null && y !== null && compareSemver(x, y) === 0
}

function semverAtLeast(a: string, b: string): boolean {
  const x = parseSemver(a)
  const y = parseSemver(b)
  return x !== null && y !== null && compareSemver(x, y) >= 0
}

export function relateRows<T extends ActionRow>(rows: T[], results: Record<string, AssessState>, currentCharts: ReadonlySet<string>): DisplayRow<T>[] {
  const plain = (row: T, relation: Relation = "none", waitingOnChart = false): DisplayRow<T> =>
    ({ ...row, displayFrom: row.facts.from, relation, absorbed: [], waitingOnChart })
  const chartRows = new Map<string, DisplayRow<T>>()
  for (const row of rows) {
    if (row.facts.kind === "upgrade-chart" && row.facts.manager.kind === "helm") chartRows.set(managerScope(row.facts.manager), plain(row))
  }
  const out: DisplayRow<T>[] = []
  for (const row of rows) {
    if (row.facts.kind !== "update-image" || row.facts.manager.kind !== "helm") {
      out.push(chartRows.get(row.facts.kind === "upgrade-chart" ? managerScope(row.facts.manager) : "") ?? plain(row))
      continue
    }
    const chart = chartRows.get(managerScope(row.facts.manager))
    if (!chart) {
      out.push(plain(row, currentCharts.has(managerScope(row.facts.manager)) ? "override" : "helm-unknown"))
      continue
    }
    const chartState = results[chart.key]
    const app = chartState?.state === "pending" ? chartState.chartAppVersions : chartState?.result.chartAppVersions
    if (app === undefined) {
      out.push(plain(row, "helm-unknown", true))
      continue
    }
    if (!app?.from || !app.to) {
      out.push(plain(row, "helm-unknown"))
      continue
    }
    if (!semverEqual(row.facts.from, app.from)) {
      out.push(plain(row))
      continue
    }
    if (semverAtLeast(app.to, row.facts.to)) {
      chart.absorbed.push(row)
      continue
    }
    out.push({ ...plain(row, "after-chart"), displayFrom: app.to })
  }
  return out
}

export function compareActionRows(a: ActionRow, b: ActionRow): number {
  return (
    KIND_ORDER[a.facts.kind] - KIND_ORDER[b.facts.kind] ||
    SEVERITY_ORDER[b.statusType] - SEVERITY_ORDER[a.statusType] ||
    a.name.localeCompare(b.name)
  )
}

function chartRef(manager: Extract<ManagerFacts, { kind: "helm" }>): string | null {
  if (!manager.chartSource) return null
  const absolute = /^(oci|https?):\/\//.test(manager.chartSource)
  if (!absolute && !manager.chartRepoUrl) return null
  return absolute ? manager.chartSource : `${manager.chartSource} --repo ${manager.chartRepoUrl}`
}

const RELATION_HINT: Partial<Record<Relation, string>> = {
  "after-chart": "Applies on top of the chart upgrade and pins the image against the chart. Kept by --reuse-values, dropped by a values file that omits it.",
  override: "This is an override the chart does not know about. Kept by --reuse-values, dropped by a values file that omits it.",
  "helm-unknown": "If the new chart ships this version, prefer the chart upgrade; this override pins the image against the chart.",
}

export function commandsFor(row: ActionRow, result: AssessResult | null, relation: Relation = "none"): HowCommand[] {
  const { facts } = row
  const manager = facts.manager
  const argoLink = manager.kind === "argo" && manager.url ? { label: "Open in Argo CD", url: manager.url } : undefined

  if (facts.kind === "upgrade-chart" && manager.kind === "helm") {
    const ref = chartRef(manager)
    return [{
      label: "helm",
      value: ref ? `helm upgrade ${manager.release} ${ref} -n ${manager.namespace} --version ${facts.to} -f values.yaml` : null,
      hint: ref ? "helm diff upgrade with the same flags previews the rendered change." : "Chart source unknown; upgrade with your usual helm upgrade invocation at --version " + facts.to,
    }]
  }

  const target = facts.kind === "pin-digest" && facts.digest ? `${facts.repository}@${facts.digest}` : `${facts.repository}:${facts.to}`
  const interim = result?.interim

  switch (manager.kind) {
    case "helm": {
      const ref = chartRef(manager)
      const key = result?.valuesKey
      const setValue = key ? (key.mode === "tag" ? (facts.kind === "pin-digest" && facts.digest ? `${facts.to}@${facts.digest}` : facts.to) : target) : null
      const version = interim && key ? (key.mode === "tag" ? interim : `${facts.repository}:${interim}`) : null
      const base = ref ? `helm upgrade ${manager.release} ${ref} -n ${manager.namespace} --version ${manager.chartVersion} --reuse-values --set ` : null
      return [{
        label: "helm",
        value: base && key && setValue ? `${base}${key.path}=${version ?? setValue}` : null,
        hint: !key
          ? `The image is not set through the release values. Add ${facts.repository}:${facts.to} to values.yaml and run helm upgrade.`
          : interim
            ? `Interim ${interim} avoids the breaking change; target ${facts.to} needs the affected values changed first.`
            : RELATION_HINT[relation],
      }]
    }
    case "argo": {
      const image = interim ? `${facts.repository}:${interim}` : target
      const change = facts.kind === "pin-digest"
        ? `Pin the ${facts.repository} image to this digest`
        : `Change the ${facts.repository} image tag from ${facts.from} to ${interim ?? facts.to}`
      return [{
        label: "argocd",
        value: image,
        hint: `${change} in the Git source of Argo app ${manager.app}, commit, and let Argo sync. Argo reverts anything changed directly on the workload.${interim ? ` Interim ${interim} avoids the breaking change in ${facts.to}.` : ""}`,
        link: argoLink,
      }]
    }
    case "standalone": {
      const kind = manager.workloadKind.toLowerCase()
      return [{
        label: "kubectl",
        value: `kubectl set image ${kind}/${manager.name} ${manager.container}=${interim ? `${facts.repository}:${interim}` : target} -n ${manager.namespace}`,
        hint: interim
          ? `Interim ${interim} avoids the breaking change in ${facts.to}.`
          : "If this is applied from a manifest in Git, change it there or the next apply undoes it.",
      }]
    }
    case "operator":
      return [{
        label: "cr",
        value: `kubectl edit ${manager.workloadKind.toLowerCase()}.${manager.apiGroup} ${manager.name} -n ${manager.namespace}`,
        hint: `Set the image to ${target} in the ${manager.workloadKind} spec; the operator owns the pods and reconciles them.`,
      }]
  }
}
