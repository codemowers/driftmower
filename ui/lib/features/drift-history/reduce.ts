import { HISTORY_SEVERITY } from "@/lib/cluster/styles/status-style"
import type { Observation } from "./build-series"
import type { BandStatus,Span,VersionMark } from "./types"
const DAY_MS = 86_400_000
const MIN_FILL_MS = 5 * 60_000
const FILL_GAP_PERCENTILE = 0.9
const FILL_GAP_SLACK = 1.25

export type Band = {
  from: number
  to: number
  status: BandStatus
  deployedTag: string | null
  latestTag: string | null
}

function bucketRank(status: BandStatus): number {
  return status === "void" ? -1 : HISTORY_SEVERITY[status]
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

export function maxFillMs(timeline: number[]): number {
  const gaps = timeline.slice(1).map((t, i) => t - timeline[i])
  return Math.min(20 * 60_000, Math.max(MIN_FILL_MS, FILL_GAP_SLACK * percentile(gaps, FILL_GAP_PERCENTILE)))
}

function toBandStatus(status: Observation["status"]): BandStatus {
  return status === "no_version" ? "no_data" : status
}

const GAP_TOLERANCE_MS = 60_000

// Row times trail their report's by seconds, so compare loosely.
function gapStatus(timeline: number[], from: number, to: number): BandStatus {
  return timeline.some(t => t > from + GAP_TOLERANCE_MS && t < to - GAP_TOLERANCE_MS) ? "void" : "no_data"
}

export function toBands(observations: Observation[], timeline: number[], fillMs: number): Band[] {
  const bands: Band[] = []

  observations.forEach((observation, i) => {
    const next = observations[i + 1]
    const to = observation.t + (next ? Math.min(next.t - observation.t, fillMs) : fillMs)

    bands.push({
      from: observation.t,
      to,
      status: toBandStatus(observation.status),
      deployedTag: observation.deployedTag,
      latestTag: observation.latestTag,
    })

    if (next && to < next.t) {
      bands.push({
        from: to,
        to: next.t,
        status: gapStatus(timeline, observation.t, next.t),
        deployedTag: null,
        latestTag: null,
      })
    }
  })

  return bands
}

export function toMarks(observations: Observation[]): VersionMark[] {
  const marks: VersionMark[] = []
  observations.forEach((observation, i) => {
    const previous = observations[i - 1]
    if (!previous) return
    if (observation.deployedTag && previous.deployedTag !== observation.deployedTag) {
      marks.push({ t: observation.t, v: observation.deployedTag, kind: "deploy" })
    }
    if (observation.latestTag && previous.latestTag !== observation.latestTag) {
      marks.push({ t: observation.t, v: observation.latestTag, kind: "upstream" })
    }
  })
  return marks
}

function bandAt(bands: Band[], from: number, to: number): Band | null {
  let worst: Band | null = null
  for (const band of bands) {
    if (band.to <= from || band.from >= to) continue
    if (!worst || bucketRank(band.status) > bucketRank(worst.status)) worst = band
  }
  return worst
}

export function toSpans(
  bands: Band[],
  windowStart: number,
  windowEnd: number,
  resolution: number,
): Span[] {
  const width = (windowEnd - windowStart) / resolution
  if (!(width > 0)) return []

  const bucketDays = width / DAY_MS
  const spans: Span[] = []

  for (let i = 0; i < resolution; i += 1) {
    const from = windowStart + i * width
    const worst = bandAt(bands, from, from + width)
    const status: BandStatus = worst?.status ?? "void"
    const v = worst?.deployedTag ?? undefined
    const l = worst?.latestTag ?? undefined
    const previous = spans[spans.length - 1]

    if (previous && previous.s === status && previous.v === v && previous.l === l) {
      previous.d += bucketDays
      continue
    }
    spans.push({ s: status, d: bucketDays, ...(v ? { v } : {}), ...(l ? { l } : {}) })
  }

  return spans
}

// Colour boundaries land on bucket edges, so unsnapped marks read as misplaced.
export function snapMarks(
  marks: VersionMark[],
  spans: Span[],
  windowStart: number,
  windowEnd: number,
): VersionMark[] {
  const totalDays = spans.reduce((sum, span) => sum + span.d, 0)
  if (totalDays <= 0) return marks

  const duration = windowEnd - windowStart
  const edges: number[] = []
  let elapsed = 0
  for (const span of spans) {
    edges.push(windowStart + (elapsed / totalDays) * duration)
    elapsed += span.d
  }
  edges.push(windowEnd)

  const tolerance = spans.reduce((min, span) => Math.min(min, span.d), Infinity) * DAY_MS * 1.5

  return marks.map(mark => {
    let best = mark.t
    let bestGap = Infinity
    for (const edge of edges) {
      const gap = Math.abs(edge - mark.t)
      if (gap < bestGap) {
        best = edge
        bestGap = gap
      }
    }
    return bestGap <= tolerance ? { ...mark, t: best } : mark
  })
}

export function clipBands(bands: Band[], windowStart: number, windowEnd: number): Band[] {
  return bands
    .filter(band => band.to > windowStart && band.from < windowEnd)
    .map(band => ({
      ...band,
      from: Math.max(band.from, windowStart),
      to: Math.min(band.to, windowEnd),
    }))
}

export function windowBounds(
  windowEnd: number,
  days: number | null,
  timeline: number[],
): { windowStart: number; windowEnd: number } {
  const earliest = timeline.length > 0 ? timeline[0] : windowEnd - DAY_MS
  if (days === null) return { windowStart: earliest, windowEnd }
  return { windowStart: Math.max(earliest, windowEnd - days * DAY_MS), windowEnd }
}
