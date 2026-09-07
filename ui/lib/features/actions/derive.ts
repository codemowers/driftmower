import type { ImageUsage, StatusType } from "@/lib/cluster/reports"
import type { ClusterResource } from "@/lib/cluster/cluster-state"
import type { VulnerabilityReport } from "@/lib/features/vulnerability/types"
import { SEVERITY_ORDER } from "@/lib/cluster/styles/status-style"
import { resolvedVersion } from "@/lib/utils/image-artifacts"
import { sourceRepoUrl } from "@/lib/utils/oci-labels"
import { compareChartVersions } from "@/lib/features/helm-releases/chart-versions"
import {
  assessKey,
  type ActionFacts,
  type ActionRow,
  type AssessResult,
  type CveFact,
  type DriftClass,
  type HowCommand,
  type ManagerFacts,
} from "./types"

const BEHIND: StatusType[] = ["patch_behind", "minor_behind", "major_behind"]
const BUILTIN_API_GROUPS = new Set(["", "apps", "batch", "v1", "core"])
const CVE_CAP = 40
const KIND_ORDER: Record<ActionFacts["kind"], number> = { "update-image": 0, "upgrade-chart": 1, "pin-digest": 2 }

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
  if (root?.argoApp) return { kind: "argo", app: root.argoApp.name, url: root.argoApp.url }
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

export function deriveActions(
  usages: ImageUsage[],
  root: ClusterResource | undefined,
  vulnReports: Record<string, VulnerabilityReport> | null,
): ActionRow[] {
  const rows: ActionRow[] = []

  for (const [repository, usage] of worstUsagePerRepo(usages)) {
    const manager = managerFacts(usages, root, usage.containerName)
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
      rows.push({ key: assessKey(facts), facts, verb: "Update image", name: shortName(repository), statusType: usage.versionStatus.statusType })
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
  }

  const release = usages[0]?.releaseInfo
  if (release?.managementKind === "helm" && release.latestChartTag && compareChartVersions(release.latestChartTag, release.chartVersion) > 0) {
    const facts: ActionFacts = {
      kind: "upgrade-chart",
      repository: `${release.chartRepoUrl ?? release.chartSource ?? "chart"}/${release.chartName}`,
      from: release.chartVersion,
      to: release.latestChartTag,
      drift: chartDrift(release.chartVersion, release.latestChartTag),
      sourceRepoUrl: null,
      cves: [],
      manager: managerFacts(usages, root, usages[0].containerName),
      chart: { name: release.chartName, repoUrl: release.chartRepoUrl, source: release.chartSource },
    }
    rows.push({ key: assessKey(facts), facts, verb: "Upgrade chart", name: release.chartName, statusType: "no_data" })
  }

  return rows.sort(compareActionRows)
}

function chartDrift(from: string, to: string): DriftClass {
  const a = from.replace(/^v/, "").split(".").map(Number)
  const b = to.replace(/^v/, "").split(".").map(Number)
  if (a[0] !== b[0]) return "major"
  if (a[1] !== b[1]) return "minor"
  return "patch"
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

export function commandsFor(row: ActionRow, result: AssessResult | null): HowCommand[] {
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
            : undefined,
      }]
    }
    case "argo": {
      const tag = interim ?? facts.to
      const helmValue = facts.kind === "pin-digest" && facts.digest ? `${facts.to}@${facts.digest}` : tag
      return [
        {
          label: "argocd",
          value: `argocd app set ${manager.app} --helm-set image.tag=${helmValue}`,
          hint: "For a Helm source. Plain manifests need the tag changed in the source repo and a sync; kubectl set image is reverted on the next sync.",
          link: argoLink,
        },
        {
          label: "argocd",
          value: `argocd app set ${manager.app} --kustomize-image ${interim ? `${facts.repository}:${interim}` : target}`,
          hint: interim ? `For a Kustomize source. Interim ${interim} avoids the breaking change in ${facts.to}.` : "For a Kustomize source.",
        },
      ]
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
