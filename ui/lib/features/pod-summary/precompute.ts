import type { ImageUsage, StatusType } from "@/lib/cluster/reports"
import type { ClusterResource } from "@/lib/cluster/cluster-state"
import {
  aggregate,
  filterListening,
  groupListening,
  type Aggregated,
  type ListeningGroup,
  type NetstatdState,
} from "@/lib/features/netstatd"
import type { VulnerabilityReport, VulnerabilitySeverity } from "@/lib/features/vulnerability/types"
import type {
  Confidence,
  EolStatus,
  ImageFacts,
  LiveFacts,
  RiskDriver,
  StaticFacts,
  StaticRisk,
  WorstCve,
} from "./types"

const SIX_MONTHS_MS = 182 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const STALE: StatusType[] = ["patch_behind", "minor_behind", "major_behind"]

const SEVERITY_RANK: Record<VulnerabilitySeverity, number> = {
  CRITICAL: 5,
  HIGH: 4,
  MEDIUM: 3,
  LOW: 2,
  UNKNOWN: 1,
  NONE: 0,
}

function eolStatus(iso?: string): EolStatus {
  if (!iso) return "ok"
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return "ok"
  if (ms < Date.now()) return "past"
  if (ms - Date.now() < SIX_MONTHS_MS) return "imminent"
  return "ok"
}

function ageDays(iso?: string): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return null
  return Math.max(0, Math.round((Date.now() - ms) / DAY_MS))
}

function moreSevere(a: { severity: VulnerabilitySeverity; score: number }, b: WorstCve): boolean {
  if (SEVERITY_RANK[a.severity] !== SEVERITY_RANK[b.severity]) {
    return SEVERITY_RANK[a.severity] > SEVERITY_RANK[b.severity]
  }
  return a.score > b.score
}

function worstVulnerability(report: VulnerabilityReport): WorstCve | null {
  let worst: WorstCve | null = null
  for (const v of report.report.vulnerabilities) {
    if (!worst || moreSevere(v, worst)) {
      worst = { id: v.vulnerabilityID, severity: v.severity, score: v.score, fixedVersion: v.fixedVersion }
    }
  }
  return worst
}

function imageFacts(usage: ImageUsage, report: VulnerabilityReport | null): ImageFacts {
  let cve: ImageFacts["cve"] = null
  if (report) {
    cve = {
      critical: report.report.summary.criticalCount,
      high: report.report.summary.highCount,
      worst: worstVulnerability(report),
    }
  }
  return {
    repo: `${usage.imageInfo.registry}/${usage.imageInfo.repository}`,
    runTag: usage.versionStatus.deployedTag,
    latestTag: usage.versionStatus.latestTag,
    drift: usage.versionStatus.statusType,
    major: usage.versionStatus.majorDifference,
    minor: usage.versionStatus.minorDifference,
    patch: usage.versionStatus.patchDifference,
    builtAgeDays: ageDays(usage.versionStatus.deployedBuiltAt),
    eol: eolStatus(usage.imageInfo.endOfLifeDate),
    scanned: report !== null,
    cve,
  }
}

export function staticFacts(
  podUsages: ImageUsage[],
  vulnReports: Record<string, VulnerabilityReport> | null,
): StaticFacts {
  const byDigest = new Map<string, ImageUsage>()
  for (const u of podUsages) {
    if (!byDigest.has(u.imageInfo.digest)) byDigest.set(u.imageInfo.digest, u)
  }

  const images = [...byDigest.values()]
    .map(u => imageFacts(u, vulnReports?.[u.imageInfo.digest] ?? null))
    .sort((a, b) => a.repo.localeCompare(b.repo) || (a.runTag ?? "").localeCompare(b.runTag ?? ""))

  let worstCve: WorstCve | null = null
  for (const img of images) {
    const w = img.cve?.worst
    if (w && (!worstCve || moreSevere(w, worstCve))) worstCve = w
  }

  const seriousCve = worstCve !== null && (worstCve.severity === "CRITICAL" || worstCve.severity === "HIGH")
  const anyPastEol = images.some(i => i.eol === "past")
  const anyStale = images.some(i => STALE.includes(i.drift))

  let riskDriver: RiskDriver = "none"
  if (seriousCve) riskDriver = "cve"
  else if (anyPastEol) riskDriver = "eol"
  else if (anyStale) riskDriver = "drift"

  const anyUnknown = images.some(i => !i.scanned || i.drift === "no_version" || i.drift === "no_data")
  const confidence: Confidence =
    images.length === 0 || (riskDriver === "none" && anyUnknown) ? "low" : "high"

  return {
    images,
    riskDriver,
    fixAvailable: Boolean(worstCve?.fixedVersion),
    confidence,
    worstSeverity: worstCve?.severity ?? null,
  }
}

export function liveFacts(
  pod: ClusterResource,
  aggregated: Aggregated,
  listeningGroups: ListeningGroup[],
  hiddenCount: number,
  staticRisk?: StaticRisk,
): LiveFacts {
  const externalInbound = aggregated.inbound.filter(r => r.kind === "external")
  return {
    pod: {
      name: pod.name,
      namespace: pod.namespace,
      node: pod.nodeName ?? null,
      phase: pod.phase ?? "Unknown",
    },
    net: {
      listening: listeningGroups.map(g => ({ port: g.port, protocol: g.protocol })),
      inbound: { external: externalInbound.length, internal: aggregated.inbound.length - externalInbound.length },
      externalInboundPeers: externalInbound.map(r => r.label).slice(0, 6),
      outboundWorkloads: aggregated.inClusterOut.map(r => r.label).slice(0, 6),
      outboundCount: aggregated.inClusterOut.length,
      externalEndpoints: aggregated.external.length,
      hidden: hiddenCount,
    },
    staticRisk,
  }
}

export function podLiveFacts(
  pod: ClusterResource,
  net: NetstatdState,
  clusterResources: ClusterResource[] | null,
  staticRisk?: StaticRisk,
): LiveFacts {
  const podIPs = new Set(pod.ips ?? [])
  return liveFacts(
    pod,
    aggregate(net.aggregates, clusterResources, net.hosts, podIPs),
    groupListening(filterListening(net.listening, podIPs)),
    net.hiddenCount,
    staticRisk,
  )
}
