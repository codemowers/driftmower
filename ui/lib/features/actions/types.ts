import type { StatusType } from "@/lib/cluster/reports"
import type { VulnerabilitySeverity } from "@/lib/features/vulnerability/types"

export const PROMPT_VERSION = 5

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
}

export type ChangeEntry = { text: string; version: string; url: string | null }
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
}

export type AssessState =
  | { state: "pending" }
  | { state: "ready"; result: AssessResult; computedAt: number }
  | { state: "failed"; result: AssessResult; computedAt: number }

export type AssessRequest = { focus: boolean; actions: ActionFacts[] }
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

export function assessKey(facts: ActionFacts): string {
  return `v${PROMPT_VERSION}:${facts.kind}:${facts.repository}|${facts.from}|${facts.to}|${managerScope(facts.manager)}`
}
