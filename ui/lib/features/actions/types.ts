import type { StatusType } from "@/lib/cluster/reports"
import type { LivePatchUpgradeTarget } from "@/lib/features/live-patch-upgrade/types"
import type { VulnerabilitySeverity } from "@/lib/features/vulnerability/types"

export const PROMPT_VERSION = 7

export type ActionKind = "update-image" | "upgrade-chart" | "pin-digest"
export type Risk = "safe" | "review" | "risky"
export type Value = "high" | "medium" | "low"
export type DriftClass = "patch" | "minor" | "major" | "unknown"

export type ManagerFacts =
  | { kind: "helm"; namespace: string; release: string; chartSource?: string; chartRepoUrl?: string; chartVersion: string }
  | { kind: "argo"; app: string; url?: string }
  | { kind: "standalone"; workloadKind: string; namespace: string; name: string; container: string }
  | { kind: "operator"; workloadKind: string; apiGroup: string; namespace: string; name: string }

export type CveFact = { id: string; severity: VulnerabilitySeverity; fixedVersion: string | null }

export type ActionFacts = {
  kind: ActionKind
  repository: string
  from: string
  to: string
  drift: DriftClass
  sourceRepoUrl: string | null
  cves: CveFact[]
  manager: ManagerFacts
  chart?: { name: string; repoUrl?: string; source?: string }
  digest?: string
}

export type ActionRow = {
  key: string
  facts: ActionFacts
  verb: string
  name: string
  statusType: StatusType
  target?: LivePatchUpgradeTarget
}

export type ClusterActionRow = ActionRow & {
  owner: { uid: string; kind: string; name: string; namespace: string }
  releaseUid: string | null
}

export type ChangeEntry ={ text: string; version: string; url: string | null }
export type ConfigKey = { path: string; type: string }
export type Affect = { entry: number; config: number; effect: "breaks" | "changes" }

export type Classification = {
  breaking: number[]
  security: number[]
  notable: number[]
  affects: Affect[]
}

export type Coverage = {
  changelog: "github" | "artifacthub" | "none"
  versionsCovered: number
  versionsTotal: number
  modelUsed: boolean
  configKeysTotal: number
  configKeysSent: number
}

export type ChartAppVersions = { from: string | null; to: string | null }

export type AssessResult = {
  risk: Risk
  value: Value
  verdict: string
  entries: ChangeEntry[]
  groups: { breaking: number[]; security: number[]; notable: number[]; other: number[] }
  affects: Affect[]
  configKeys: ConfigKey[]
  coverage: Coverage
  sources: { label: string; url: string }[]
  valuesKey: { path: string; mode: "tag" | "image" } | null
  interim: string | null
  chartAppVersions: ChartAppVersions | null
}

export type Relation = "none" | "after-chart" | "override" | "helm-unknown"

export type DisplayRow<T extends ActionRow = ActionRow> = T & {
  displayFrom: string
  relation: Relation
  absorbed: T[]
  waitingOnChart: boolean
}

export type AssessState =
  | { state: "pending"; chartAppVersions?: ChartAppVersions | null }
  | { state: "ready"; result: AssessResult; computedAt: number }
  | { state: "failed"; result: AssessResult; computedAt: number }
export type AssessResponse = { results: Record<string, AssessState> }

export type HowCommand = {
  label: "helm" | "argocd" | "kubectl" | "cr"
  value: string | null
  hint?: string
  link?: { label: string; url: string }
}

export function managerScope(manager: ManagerFacts): string {
  switch (manager.kind) {
    case "helm":
      return `helm:${manager.namespace}/${manager.release}`
    case "argo":
      return `argo:${manager.app}`
    case "standalone":
      return `standalone:${manager.workloadKind}/${manager.namespace}/${manager.name}/${manager.container}`
    case "operator":
      return `operator:${manager.workloadKind}/${manager.namespace}/${manager.name}`
  }
}

// The namespace a manager names, or null for the one kind that names none.
// Callers that authorize on a namespace need this: managerScope feeds the hash
// that becomes a cluster-scoped object name, so a manager pointing at one
// namespace while the request authorizes against another is how a caller
// reaches someone else's object.
// Structural on purpose: the request parser validates against a looser schema
// than ManagerFacts, and this only needs the two fields.
export function managerNamespace(manager: { kind: string; namespace?: unknown }): string | null {
  if (manager.kind === "argo") return null
  return typeof manager.namespace === "string" ? manager.namespace : null
}

function factsHash(facts: ActionFacts): string {
  const text = JSON.stringify(facts)
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

export function assessKey(facts: ActionFacts): string {
  return `v${PROMPT_VERSION}:${facts.kind}:${facts.repository}|${facts.from}|${facts.to}|${managerScope(facts.manager)}|${factsHash(facts)}`
}
