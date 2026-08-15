import {
  STACK_STATUSES,
  type ClusterStats,
  type DriftSparkline,
  type StackPoint,
  type StackStatus,
} from "./types"
import { HISTORY_SEVERITY } from "@/lib/cluster/status-style"
import { clipBands, maxFillMs, toBands, toMarks, toSpans } from "./reduce"
import type { Observation, SeriesSource } from "./build-series"
import { seriesStats, trendBetween } from "./stats"

function mergeObservations(sources: SeriesSource[]): Observation[] {
  const byTime = new Map<number, Observation>()

  for (const source of sources) {
    for (const observation of source.observations) {
      const existing = byTime.get(observation.t)
      if (!existing) {
        byTime.set(observation.t, { ...observation })
        continue
      }
      existing.containerCount += observation.containerCount
      if (HISTORY_SEVERITY[observation.status] > HISTORY_SEVERITY[existing.status]) {
        existing.status = observation.status
        existing.deployedTag = observation.deployedTag
        existing.latestTag = observation.latestTag
      }
    }
  }

  return [...byTime.values()].sort((a, b) => a.t - b.t)
}

export function groupBy(sources: SeriesSource[], keyOf: (source: SeriesSource) => string): Map<string, SeriesSource[]> {
  const groups = new Map<string, SeriesSource[]>()
  for (const source of sources) {
    const key = keyOf(source)
    const bucket = groups.get(key)
    if (bucket) bucket.push(source)
    else groups.set(key, [source])
  }
  return groups
}

export function sparklines(
  groups: Map<string, SeriesSource[]>,
  timeline: number[],
  windowStart: number,
  windowEnd: number,
  resolution: number,
): DriftSparkline[] {
  const fillMs = maxFillMs(timeline)

  return [...groups].map(([key, sources]) => {
    const observations = mergeObservations(sources)
    const marks = toMarks(observations)
    const clipped = clipBands(toBands(observations, timeline, fillMs), windowStart, windowEnd)
    return {
      key,
      spans: toSpans(clipped, windowStart, windowEnd, resolution),
      stats: seriesStats(clipped, marks, windowStart, windowEnd),
    }
  })
}

function emptyCounts(): Record<StackStatus, number> {
  return Object.fromEntries(STACK_STATUSES.map(status => [status, 0])) as Record<StackStatus, number>
}

export function clusterStack(
  sources: SeriesSource[],
  windowStart: number,
  windowEnd: number,
): StackPoint[] {
  const byTime = new Map<number, StackPoint>()

  for (const source of sources) {
    for (const observation of source.observations) {
      if (observation.t < windowStart || observation.t > windowEnd) continue
      let point = byTime.get(observation.t)
      if (!point) {
        point = { t: observation.t, total: 0, counts: emptyCounts() }
        byTime.set(observation.t, point)
      }
      const status: StackStatus = observation.status === "no_version" ? "no_data" : observation.status
      point.counts[status] += observation.containerCount
      point.total += observation.containerCount
    }
  }

  return [...byTime.values()].sort((a, b) => a.t - b.t)
}

const STREAK_TIE_DAYS = 1 / 24

export function clusterStats(perSeries: DriftSparkline[]): ClusterStats {
  let improved = 0
  let regressed = 0
  let unchanged = 0
  let greenDays = 0
  let measuredDays = 0
  let updateDays = 0
  let updateCount = 0

  for (const { stats } of perSeries) {
    measuredDays += stats.measuredDays
    if (stats.greenRatio !== null) greenDays += stats.greenRatio * stats.measuredDays
    if (stats.meanTimeToUpdateDays !== null) {
      updateDays += stats.meanTimeToUpdateDays
      updateCount += 1
    }
    const trend = trendBetween(stats.startStatus, stats.currentStatus)
    if (trend === "improved") improved += 1
    else if (trend === "regressed") regressed += 1
    else unchanged += 1
  }

  const longestBehindStreakDays = Math.max(0, ...perSeries.map(s => s.stats.longestBehindStreakDays))
  // Report skew puts tied series minutes apart, so near enough counts as tied.
  const longest = perSeries.filter(
    s => longestBehindStreakDays > 0 && s.stats.longestBehindStreakDays > longestBehindStreakDays - STREAK_TIE_DAYS,
  )

  return {
    greenRatio: measuredDays > 0 ? greenDays / measuredDays : null,
    measuredDays,
    improved,
    regressed,
    unchanged,
    seriesCount: perSeries.length,
    meanTimeToUpdateDays: updateCount > 0 ? updateDays / updateCount : null,
    updateCount,
    longestBehindStreakDays,
    longestBehindSeries: longest.length === 1 ? longest[0].key : null,
    longestBehindCount: longest.length,
  }
}
