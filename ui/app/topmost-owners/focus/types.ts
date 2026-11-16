import type { ReactNode } from "react"
import type { StatusType } from "@/lib/cluster/reports"
import type { SummaryPill } from "@/lib/cluster/styles/status-style"
import type { PodSummary } from "@/lib/utils/pods-by-root"
import type { SeriesStats, Span } from "@/lib/features/drift-history/types"

export type WorkloadEntry = {
  // Held in the namespace's orphan bucket: the bucket itself, or a Pod
  // without an owner.
  orphan?: "bucket" | "pod"
  // What an orphan bucket holds, for its row.
  orphanSummary?: string
  sourceState?: "linked" | "unlinked" | "unknown"
  desiredReplicas?: number
  completed?: boolean
  groupKey: string
  uid: string
  kind: string
  name: string
  namespace: string
  manager:
    | { kind: "helm"; name: string; uid?: string }
    | { kind: "argo"; name: string; url?: string }
    | { kind: "standalone" }
  worstStatus: StatusType
  repos: string[]
  drift: {
    containerCount: number
    staleRepoCount: number
    distinctRepoCount: number
  }
  pods?: PodSummary
  history?: { spans: Span[]; stats: SeriesStats }
}

export type FocusKey = "drift" | "pods" | "history"

export type ScaleLevel = {
  token: string
  label: string
  match: (entry: WorkloadEntry) => boolean
}

export type FocusDefinition = {
  key: FocusKey
  label: string
  scale: ScaleLevel[]
  secondary: (entries: WorkloadEntry[]) => { label: string; count: number }
  pills: (entries: WorkloadEntry[]) => SummaryPill[]
  headers: [string, string, string]
  gridCols: string
  renderCells: (entry: WorkloadEntry) => ReactNode
  compare: (a: WorkloadEntry, b: WorkloadEntry) => number
}
