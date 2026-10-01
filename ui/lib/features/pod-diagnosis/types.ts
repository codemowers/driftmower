import type { PodStatus } from "@/lib/cluster/cluster-state"
import type { NodePressure } from "@/lib/cluster-resources/types"

export const PROMPT_VERSION = 3

export const DIAGNOSIS_CATEGORIES = ["crash", "oom", "probe", "evicted", "config", "image-pull", "unschedulable", "node", "dependency", "volume", "rbac"] as const
export const FIX_KINDS = ["config", "resources", "image", "manager", "cleanup", "dependency", "node", "spec", "volume", "rbac", "placement", "namespace", "none"] as const

export type DiagnosisCategory = (typeof DIAGNOSIS_CATEGORIES)[number]
export type FixKind = (typeof FIX_KINDS)[number]
export type EvidenceKind = "logs" | "status" | "event" | "spec" | "node" | "siblings" | "release" | "metrics"

export const K3S_CHART_LABEL = "helmcharts.helm.cattle.io/chart"

export type ManagerFacts = { kind: "helm" | "argo" | "k3s-chart" | "none"; namespace?: string; name?: string }

export type ReleasePod = { name: string; state: string; ready: boolean; restarts: number; ips?: string[] }

export type DiagnosisFacts = {
  key: string
  podUid: string
  namespace: string
  name: string
  nodeName: string | null
  ownerKind: string | null
  ownerName: string | null
  ownerUid: string | null
  topmostKind: string | null
  topmostName: string | null
  topmostUid: string | null
  manager: ManagerFacts
  podStatus: PodStatus
  createdAt: string | null
  duplicates: number
  siblings: { total: number; byState: Record<string, number>; nodes: string[] }
  release: ReleasePod[]
  node: { ready: boolean; pressure: NodePressure; storageUsedPct: number | null } | null
  metrics: { memoryBytes: number | null; memoryLimitBytes: number | null; cpuCores: number | null; cpuLimitCores: number | null } | null
}

export type Evidence = { kind: EvidenceKind; label: string; text: string; link: "logs" | "yaml" | "node" | "pods" | null }

export type FixCommand = { label: "kubectl" | "helm" | "argocd" | "path"; value: string }

export type DiagnosisResult = {
  category: DiagnosisCategory | null
  cause: string
  confidence: "high" | "medium" | "low"
  confidenceNote: string
  evidence: Evidence[]
  fix: { kind: FixKind; commands: FixCommand[]; action: string }
  check: string
  since: string | null
}

export type DiagnosisState =
  | { state: "pending"; result?: DiagnosisResult; computedAt?: number }
  | { state: "ready"; result: DiagnosisResult; computedAt: number }
  | { state: "failed"; result: DiagnosisResult; computedAt: number }

export type DiagnoseRequest = { podUid: string; force: boolean } | { prewarm: true }
export type DiagnoseResponse = { key: string | null; results: Record<string, DiagnosisState> }
