import type { BandStatus, SeriesStats, VersionMark } from "./types"
import type { Band } from "./reduce"

const DAY_MS = 86_400_000

const GREEN: BandStatus[] = ["up_to_date", "ahead"]
const BEHIND: BandStatus[] = ["patch_behind", "minor_behind", "major_behind", "behind"]

export function isGreen(status: BandStatus): boolean {
  return GREEN.includes(status)
}

export function isBehind(status: BandStatus): boolean {
  return BEHIND.includes(status)
}

function isMeasured(status: BandStatus): boolean {
  return isGreen(status) || isBehind(status)
}

const MAGNITUDE: Partial<Record<BandStatus, number>> = {
  patch_behind: 1,
  minor_behind: 2,
  major_behind: 3,
}

export type Trend = "improved" | "regressed" | "unchanged"

// "behind" states no magnitude, so it never ranks against the ones that do.
export function trendBetween(start: BandStatus, current: BandStatus): Trend {
  if (!isMeasured(start) || !isMeasured(current)) return "unchanged"
  if (isGreen(start) && isGreen(current)) return "unchanged"
  if (isGreen(start)) return "regressed"
  if (isGreen(current)) return "improved"

  const from = MAGNITUDE[start]
  const to = MAGNITUDE[current]
  if (from === undefined || to === undefined || from === to) return "unchanged"
  return to < from ? "improved" : "regressed"
}

// Takes full-resolution bands, not spans, or the numbers drift from the strip.
export function seriesStats(
  bands: Band[],
  marks: VersionMark[],
  windowStart: number,
  windowEnd: number,
): SeriesStats {
  let measuredMs = 0
  let greenMs = 0
  let longestBehindMs = 0
  let behindRunMs = 0
  let episodeStart: number | null = null
  const closedEpisodes: number[] = []

  for (const band of bands) {
    const span = band.to - band.from
    if (isMeasured(band.status)) measuredMs += span
    if (isGreen(band.status)) greenMs += span

    if (isBehind(band.status)) {
      behindRunMs += span
      if (episodeStart === null) episodeStart = band.from
      longestBehindMs = Math.max(longestBehindMs, behindRunMs)
      continue
    }

    if (isGreen(band.status) && episodeStart !== null) {
      closedEpisodes.push(band.from - episodeStart)
    }
    // Absence breaks a streak without closing an episode: no update happened.
    behindRunMs = 0
    episodeStart = null
  }

  const first = bands[0]
  const last = bands[bands.length - 1]
  const inWindow = marks.filter(mark => mark.t >= windowStart && mark.t <= windowEnd)

  return {
    greenRatio: measuredMs > 0 ? greenMs / measuredMs : null,
    measuredDays: measuredMs / DAY_MS,
    meanTimeToUpdateDays:
      closedEpisodes.length > 0
        ? closedEpisodes.reduce((sum, ms) => sum + ms, 0) / closedEpisodes.length / DAY_MS
        : null,
    longestBehindStreakDays: longestBehindMs / DAY_MS,
    startStatus: first?.status ?? "void",
    currentStatus: last?.status ?? "void",
    lastDeployAt: inWindow.length > 0 ? inWindow[inWindow.length - 1].t : null,
  }
}
