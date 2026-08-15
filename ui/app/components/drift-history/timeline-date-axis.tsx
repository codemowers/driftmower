"use client"

import { layOutBands } from "@/lib/cluster/drift-history/bands"
import { axisDate } from "@/lib/cluster/drift-history/format"
import type { Span, VersionMark } from "@/lib/cluster/drift-history/types"
import { cn } from "@/lib/utils/cn"
import { TIMELINE_ROW_GRID } from "./drift-timeline-row"

type AxisSeries = { spans: Span[]; marks?: VersionMark[] }

type Props = {
  series: AxisSeries[]
  windowStart: number
  windowEnd: number
}

type Tick = { t: number; left: number; label: string; row: number }

const MIN_LABEL_GAP_PERCENT = 8

function changeInstants(series: AxisSeries[], windowStart: number, windowEnd: number): number[] {
  const instants = new Set<number>()

  for (const entry of series) {
    for (const band of layOutBands(entry.spans, windowStart, windowEnd).slice(1)) {
      instants.add(Math.round(band.from))
    }
    for (const mark of entry.marks ?? []) {
      if (mark.t >= windowStart && mark.t <= windowEnd) instants.add(Math.round(mark.t))
    }
  }

  return [...instants].sort((a, b) => a - b)
}

function toTicks(instants: number[], windowStart: number, duration: number): Tick[] {
  const labelledDays = new Set<string>()
  const rowEnds = [-Infinity, -Infinity]
  const ticks: Tick[] = []

  for (const t of instants) {
    const day = axisDate(t)
    if (labelledDays.has(day)) continue

    const left = ((t - windowStart) / duration) * 100
    const row = rowEnds.findIndex(end => left - end >= MIN_LABEL_GAP_PERCENT)
    if (row === -1) continue

    labelledDays.add(day)
    rowEnds[row] = left
    ticks.push({ t, left, label: day, row })
  }

  return ticks
}

export default function TimelineDateAxis({ series, windowStart, windowEnd }: Props) {
  const duration = windowEnd - windowStart
  if (series.length === 0 || duration <= 0) return null

  const ticks = toTicks(changeInstants(series, windowStart, windowEnd), windowStart, duration)
  if (ticks.length === 0) return null
  const twoRows = ticks.some(tick => tick.row === 1)

  return (
    <div className={cn(TIMELINE_ROW_GRID, "pt-1 pb-1")}>
      <div />
      <div className={cn("relative", twoRows ? "h-10" : "h-6")}>
        {ticks.map(tick => (
          <div
            key={`line-${tick.t}`}
            className="absolute top-0 h-1.5 w-px -translate-x-1/2 bg-muted-foreground/50"
            style={{ left: `${tick.left}%` }}
          />
        ))}
        {ticks.map(tick => (
          <span
            key={`label-${tick.t}`}
            className={cn(
              "absolute font-mono text-[10px] whitespace-nowrap text-muted-foreground",
              tick.row === 0 ? "top-2" : "top-[22px]",
              tick.left > 97 ? "-translate-x-full" : tick.left >= 3 && "-translate-x-1/2",
            )}
            style={{ left: `${tick.left}%` }}
          >
            {tick.label}
          </span>
        ))}
      </div>
      <div />
    </div>
  )
}
