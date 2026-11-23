import { imageBuildTime } from "../features/image-build-time.ts"
import type { ClusterResource } from "./cluster-state"
import type { ImageUsage } from "./reports"

// Tiers from most to least severe. Pod evaluation reports critical and
// warning; version drift adds the lower tiers.
export type IssueSeverity = "critical" | "warning" | "notice" | "info"

export type WorkloadIssue = {
  code: string
  severity: IssueSeverity
  message: string
  containerCount?: number
  podCount?: number
}

export const ISSUE_SEVERITIES: IssueSeverity[] = ["critical", "warning", "notice", "info"]

// Powers of three: one issue outranks two of the tier below it.
export const ISSUE_WEIGHT: Record<IssueSeverity, number> = { critical: 27, warning: 9, notice: 3, info: 1 }

export const ISSUE_STYLE: Record<IssueSeverity, { bg: string; text: string }> = {
  critical: { bg: "bg-status-major-bg", text: "text-status-major-label" },
  warning: { bg: "bg-status-minor-bg", text: "text-status-minor-label" },
  notice: { bg: "bg-status-patch-bg", text: "text-status-patch-label" },
  info: { bg: "bg-status-neutral-bg", text: "text-status-neutral-label" },
}

// What each issue code means, and the badge it shows when the severity alone
// would not tell the issues apart.
const KINDS: Record<string, { label: string; badge?: string }> = {
  "major-version": { label: "Major version behind", badge: "major" },
  "minor-version": { label: "Minor version behind", badge: "minor" },
  "patch-version": { label: "Patch version behind", badge: "patch" },
  "version-behind": { label: "Release behind", badge: "behind" },
  "stale-image": { label: "Stale image", badge: "stale" },
  hostNetwork: { label: "Host network" },
  hostPID: { label: "Host PID namespace" },
  hostIPC: { label: "Host IPC namespace" },
  privileged: { label: "Privileged" },
  root: { label: "Runs as root" },
  "unrestricted-user": { label: "May run as root" },
  "user-namespace-root": { label: "Root in user namespace" },
  "privilege-escalation": { label: "Privilege escalation" },
  "added-capability": { label: "Added capabilities" },
  "host-volume": { label: "Host path volume" },
  "missing-cpu-request": { label: "No CPU request" },
  "missing-cpu-limit": { label: "No CPU limit" },
  "missing-memory-request": { label: "No memory request" },
  "missing-memory-limit": { label: "No memory limit" },
}

export function issueLabel(code: string): string {
  return KINDS[code]?.label ?? code.replaceAll("-", " ")
}

export function issueBadge(issue: WorkloadIssue): string {
  return KINDS[issue.code]?.badge ?? issue.severity
}

export function compareIssues(a: WorkloadIssue, b: WorkloadIssue): number {
  return ISSUE_WEIGHT[b.severity] - ISSUE_WEIGHT[a.severity] || (b.podCount ?? 0) - (a.podCount ?? 0) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message)
}

// Linear progression from six months to two years, mapped onto issue tiers.
// This is declared image build age, independent of Pod/deployment age.
const MONTH_MS = 365.25 * 86_400_000 / 12
export function imageAgeSeverity(ageMonths:number): IssueSeverity | null {
  if (!Number.isFinite(ageMonths) || ageMonths <= 6) return null
  const tier = Math.min(3, Math.floor((ageMonths - 6) / 6))
  return (["info", "notice", "warning", "critical"] as const)[tier]
}

// One version finding and one age finding per repository, retaining the worst
// observed version and oldest declared build. Replicas do not multiply issues.
export function driftIssues(usages: ImageUsage[], now = Date.now()): WorkloadIssue[] {
  const byRepo = new Map<string, WorkloadIssue>()
  const stale = new Map<string, {ageMonths:number; containers:Set<string>}>()
  for (const u of usages) {
    if (u.finished) continue
    const v = u.versionStatus
    const repo = `${u.imageInfo.registry}/${u.imageInfo.repository}`
    const versions = `${v.deployedTag ?? u.imageInfo.tag ?? "?"} → ${v.latestTag ?? "?"}`
    const issue: WorkloadIssue | null =
      v.statusType === "major_behind" ? { code: "major-version", severity: "warning", message: `${repo} ${versions}, ${v.majorDifference} major ${v.majorDifference === 1 ? "version" : "versions"} behind` }
      : v.statusType === "minor_behind" ? { code: "minor-version", severity: "notice", message: `${repo} ${versions}, ${v.minorDifference} minor ${v.minorDifference === 1 ? "version" : "versions"} behind` }
      : v.statusType === "patch_behind" ? { code: "patch-version", severity: "info", message: `${repo} ${versions}, ${v.patchDifference} ${v.patchDifference === 1 ? "patch" : "patches"} behind` }
      : v.statusType === "behind" ? { code: "version-behind", severity: "notice", message: `${repo} ${versions}, behind the latest published release` }
      : null
    const existing = byRepo.get(repo)
    if (issue && (!existing || ISSUE_WEIGHT[issue.severity] > ISSUE_WEIGHT[existing.severity])) byRepo.set(repo, issue)
    const buildTime = imageBuildTime(u.imageInfo.labels?.["org.opencontainers.image.created"], [{digest:u.imageInfo.digest,configCreated:u.imageInfo.configCreated}]).primary
    const builtAt = Date.parse(buildTime?.timestamp ?? "")
    const ageMonths = (now - builtAt) / MONTH_MS
    if (imageAgeSeverity(ageMonths)) {
      const entry = stale.get(repo) ?? {ageMonths,containers:new Set<string>()}
      entry.ageMonths = Math.max(entry.ageMonths, ageMonths)
      entry.containers.add(JSON.stringify([u.context,u.namespace,u.uid,u.containerName]))
      stale.set(repo,entry)
    }
  }
  return [...byRepo.values(), ...[...stale].map(([repo,entry]):WorkloadIssue=>({
    code:"stale-image",severity:imageAgeSeverity(entry.ageMonths)!,
    message:`${repo} has a stale image; oldest declared build is ${Math.floor(entry.ageMonths)} months old`,
    containerCount:entry.containers.size,
  }))]
}

export function issueCounts(issue:WorkloadIssue):string {
  return [
    issue.containerCount !== undefined ? `${issue.containerCount} ${issue.containerCount===1?"container":"containers"}` : undefined,
    issue.podCount !== undefined ? `${issue.podCount} ${issue.podCount===1?"Pod":"Pods"}` : undefined,
  ].filter(Boolean).join(" · ")
}

// A workload's issue rank: each kind of issue counts by its tier, and further
// occurrences of the same kind add logarithmically, so breadth matters more
// than repetition.
export function issueRank(issues: WorkloadIssue[]): { score: number; worst?: IssueSeverity } {
  const byCode = new Map<string, { severity: IssueSeverity; count: number }>()
  for (const i of issues) {
    const kind = byCode.get(i.code)
    if (!kind) byCode.set(i.code, { severity: i.severity, count: 1 })
    else {
      kind.count++
      if (ISSUE_WEIGHT[i.severity] > ISSUE_WEIGHT[kind.severity]) kind.severity = i.severity
    }
  }
  let score = 0
  let worst: IssueSeverity | undefined
  for (const { severity, count } of byCode.values()) {
    score += ISSUE_WEIGHT[severity] * (1 + Math.log2(count))
    if (!worst || ISSUE_WEIGHT[severity] > ISSUE_WEIGHT[worst]) worst = severity
  }
  return { score: Math.round(score), worst }
}

// Aggregate the already evaluated Pod issues; never re-evaluate Pod specs here.
export function namespaceIssues(resources: ClusterResource[]): Map<string, WorkloadIssue[]> {
  const namespaces = new Map<string, Map<string, WorkloadIssue>>()
  const seen = new Set<string>()
  for (const pod of resources) {
    if (pod.kind !== "Pod" || seen.has(pod.uid)) continue
    seen.add(pod.uid)
    const issues = namespaces.get(pod.namespace) ?? new Map<string, WorkloadIssue>()
    namespaces.set(pod.namespace, issues)
    for (const issue of pod.issues ?? []) {
      const key = `${issue.code}:${issue.message}`
      const existing = issues.get(key)
      issues.set(key, { ...issue, podCount: (existing?.podCount ?? 0) + 1,
        ...(issue.containerCount !== undefined ? {containerCount:(existing?.containerCount??0)+issue.containerCount} : {}),
      })
    }
  }
  return new Map([...namespaces].map(([name, issues]) => [name, [...issues.values()].sort(compareIssues)]))
}
