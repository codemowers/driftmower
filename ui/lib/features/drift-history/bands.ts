import type { BandStatus, Span, VersionMark } from "./types"

export type LaidOutBand = {
  s: BandStatus
  left: number
  width: number
  from: number
  to: number
  v?: string
  l?: string
}

export type LaidOutMark = VersionMark & { left: number }

export type BandGeometry = LaidOutBand & { renderWidth: number; raised: boolean }

const FLOOR_PERCENT = 1.6

export function withMinWidth(bands: LaidOutBand[]): BandGeometry[] {
  const floor = Math.min(FLOOR_PERCENT, 100 / bands.length)
  return bands.map(band => ({
    ...band,
    renderWidth: Math.max(band.width, floor),
    raised: band.width < floor,
  }))
}

export function layOutBands(spans: Span[], windowStart: number, windowEnd: number): LaidOutBand[] {
  const totalDays = spans.reduce((sum, span) => sum + span.d, 0)
  if (totalDays <= 0) return []

  const duration = windowEnd - windowStart
  let elapsed = 0

  return spans.map(span => {
    const left = (elapsed / totalDays) * 100
    elapsed += span.d
    const right = (elapsed / totalDays) * 100
    return {
      s: span.s,
      left,
      width: right - left,
      from: windowStart + (left / 100) * duration,
      to: windowStart + (right / 100) * duration,
      ...(span.v ? { v: span.v } : {}),
      ...(span.l ? { l: span.l } : {}),
    }
  })
}

export function layOutMarks(
  marks: VersionMark[],
  windowStart: number,
  windowEnd: number,
): LaidOutMark[] {
  const duration = windowEnd - windowStart
  if (duration <= 0) return []
  return marks.map(mark => ({ ...mark, left: ((mark.t - windowStart) / duration) * 100 }))
}
