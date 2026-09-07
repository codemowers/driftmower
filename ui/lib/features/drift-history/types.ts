import type { StatusType } from "@/lib/cluster/reports"

export type BandStatus = StatusType | "void"

export type Span = {
  s: BandStatus
  d: number
  v?: string
  l?: string
}

export type MarkKind = "deploy" | "upstream"

export type VersionMark = {
  t: number
  v: string
  kind: MarkKind
}

export type SeriesStats = {
  greenRatio: number | null
  measuredDays: number
  meanTimeToUpdateDays: number | null
  longestBehindStreakDays: number
  startStatus: BandStatus
  currentStatus: BandStatus
  lastDeployAt: number | null
}

export type DigestSeries = {
  digest: string
  containerCount: number
  spans: Span[]
  marks: VersionMark[]
  releases: number
}

export type DriftSeries = {
  key: string
  registry: string
  repository: string
  workloadGroupKey: string
  workloadKind: string
  workloadName: string
  workloadNamespace: string
  containerCount: number
  digests: DigestSeries[]
  spans: Span[]
  marks: VersionMark[]
  stats: SeriesStats
}

export type DriftSparkline = {
  key: string
  spans: Span[]
  stats: SeriesStats
}

export type StackPoint = {
  t: number
  total: number
  counts: Record<StackStatus, number>
}

export const STACK_STATUSES = [
  "up_to_date",
  "ahead",
  "patch_behind",
  "minor_behind",
  "major_behind",
  "behind",
  "no_data",
] as const

export type StackStatus = (typeof STACK_STATUSES)[number]

export type RottennessPoint = {
  t: number
  score: number
  containers: number
}

export type ClusterStats = {
  greenRatio: number | null
  measuredDays: number
  improved: number
  regressed: number
  unchanged: number
  seriesCount: number
  meanTimeToUpdateDays: number | null
  updateCount: number
  longestBehindStreakDays: number
  longestBehindSeries: string | null
  longestBehindCount: number
}
