import type { StatusType } from "@/lib/cluster/reports"
import { HISTORY_SEVERITY } from "@/lib/cluster/styles/status-style"
import { clipBands,maxFillMs,snapMarks,toBands,toMarks,toSpans } from "./reduce"
import { seriesStats } from "./stats"
import type { DigestSeries,DriftSeries,SeriesStats } from "./types"

export type Observation = {
  t: number
  status: StatusType
  deployedTag: string | null
  latestTag: string | null
  containerCount: number
}

export type SeriesSource = {
  key: string
  registry: string
  repository: string
  workloadGroupKey: string
  workloadUid: string
  workloadKind: string
  workloadName: string
  workloadNamespace: string
  observations: Observation[]
  byDigest: Map<string, Observation[]>
}

export type Window = { windowStart: number; windowEnd: number; timeline: number[] }

export const BULK_RESOLUTION = 70
export const DETAIL_RESOLUTION = 400

export function seriesKey(workloadGroupKey: string, registry: string, repository: string): string {
  return `${workloadGroupKey}|${registry}/${repository}`
}

export function imageKey(registry: string, repository: string): string {
  return `${registry}/${repository}`
}

export function rank(status: SeriesStats["currentStatus"]): number {
  return status === "void" ? -1 : HISTORY_SEVERITY[status]
}

// One line per digest, so a build nobody replaced stays attributable.
function reduceDigests(source: SeriesSource, window: Window, resolution: number): DigestSeries[] {
  if (source.byDigest.size < 2) return []
  const { windowStart, windowEnd, timeline } = window
  const fillMs = maxFillMs(timeline)

  return [...source.byDigest]
    .map(([digest, observations]) => {
      const marks = toMarks(observations).filter(mark => mark.t >= windowStart && mark.t <= windowEnd)
      const clipped = clipBands(toBands(observations, timeline, fillMs), windowStart, windowEnd)
      const spans = toSpans(clipped, windowStart, windowEnd, resolution)
      return {
        digest,
        containerCount: observations[observations.length - 1]?.containerCount ?? 0,
        spans,
        marks: snapMarks(marks, spans, windowStart, windowEnd),
        releases: marks.filter(mark => mark.kind === "upstream").length,
      }
    })
    .sort((a, b) => b.releases - a.releases || a.digest.localeCompare(b.digest))
}

export function reduceSeries(source: SeriesSource, window: Window, resolution: number): DriftSeries {
  const { windowStart, windowEnd, timeline } = window
  const bands = toBands(source.observations, timeline, maxFillMs(timeline))
  const marks = toMarks(source.observations)
  const clipped = clipBands(bands, windowStart, windowEnd)
  const spans = toSpans(clipped, windowStart, windowEnd, resolution)
  const inWindow = marks.filter(mark => mark.t >= windowStart && mark.t <= windowEnd)

  return {
    key: source.key,
    registry: source.registry,
    repository: source.repository,
    workloadGroupKey: source.workloadGroupKey,
    workloadKind: source.workloadKind,
    workloadName: source.workloadName,
    workloadNamespace: source.workloadNamespace,
    containerCount: source.observations[source.observations.length - 1]?.containerCount ?? 0,
    digests: reduceDigests(source, window, resolution),
    spans,
    marks: snapMarks(inWindow, spans, windowStart, windowEnd),
    stats: seriesStats(clipped, marks, windowStart, windowEnd),
  }
}

export function detailSeries(sources: SeriesSource[], window: Window, resolution: number): DriftSeries[] {
  return sources
    .map(source => reduceSeries(source, window, resolution))
    .sort((a, b) => rank(b.stats.currentStatus) - rank(a.stats.currentStatus) || a.key.localeCompare(b.key))
}
