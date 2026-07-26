import type { ReactNode } from "react"
import type { StatusType } from "@/lib/cluster/reports"
import type { SummaryPill } from "@/lib/cluster/status-style"
import type { PodSummary } from "../utils/pod-summary"

export type WorkloadEntry = {
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
  issueCount: number
  inReport: boolean
  repos: string[]
  drift?: {
    containerCount: number
    staleRepoCount: number
    distinctRepoCount: number
  }
  pods?: PodSummary
}

export type FocusKey = "drift" | "pods"

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
