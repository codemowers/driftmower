"use client"

import { useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import StatusTimelineStrip from "./status-timeline-strip"
import { percentLabel } from "@/lib/cluster/drift-history/format"
import type { DriftSeries } from "@/lib/cluster/drift-history/types"
import { digestCrumb } from "@/lib/utils/image-artifacts"
import { cn } from "@/lib/utils/cn"

export const TIMELINE_ROW_GRID = "grid grid-cols-[minmax(140px,260px)_1fr_minmax(104px,auto)] items-center gap-x-4"

export function greenText(ratio: number | null): string {
  if (ratio === null) return "text-muted-foreground"
  if (ratio >= 0.8) return "text-status-ok-label"
  if (ratio >= 0.5) return "text-status-minor-label"
  return "text-status-major-label"
}

type Props = {
  series: DriftSeries
  title: string
  subtitle: string
  windowStart: number
  windowEnd: number
}

export default function DriftTimelineRow({ series, title, subtitle, windowStart, windowEnd }: Props) {
  const [open, setOpen] = useState(false)
  const hasDigests = series.digests.length > 1
  const notComparable = series.stats.greenRatio === null

  return (
    <div className="py-2">
      <div className={TIMELINE_ROW_GRID}>
        {hasDigests ? (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="flex min-w-0 cursor-pointer items-center gap-1 text-left"
          >
            {open ? (
              <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0">
              <span className="block truncate font-mono text-xs text-foreground">{title}</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {subtitle}, {series.digests.length} digests seen
              </span>
            </span>
          </button>
        ) : (
          <div className="flex min-w-0 items-center gap-1">
            <span className="w-3 shrink-0" />
            <span className="min-w-0">
              <span className="block truncate font-mono text-xs text-foreground">{title}</span>
              <span className="block truncate text-[11px] text-muted-foreground">{subtitle}</span>
            </span>
          </div>
        )}

        <StatusTimelineStrip
          spans={series.spans}
          marks={series.marks}
          windowStart={windowStart}
          windowEnd={windowEnd}
        />

        <div className="text-right font-mono text-xs whitespace-nowrap">
          <span className={cn("font-semibold", greenText(series.stats.greenRatio))}>
            {percentLabel(series.stats.greenRatio)}
          </span>
          <span className="block text-[10px] text-muted-foreground">
            {notComparable ? "not comparable" : "green"}
          </span>
        </div>
      </div>

      {open &&
        series.digests.map(digest => (
          <div key={digest.digest} className={cn(TIMELINE_ROW_GRID, "mt-1.5")}>
            <div className="min-w-0 pl-4">
              <span className="block truncate font-mono text-[11px] text-muted-foreground">
                {digestCrumb(digest.digest)}
              </span>
              <span className="block truncate text-[10px] text-muted-foreground">
                {digest.containerCount} container{digest.containerCount === 1 ? "" : "s"}
              </span>
            </div>

            <StatusTimelineStrip
              spans={digest.spans}
              marks={digest.marks}
              windowStart={windowStart}
              windowEnd={windowEnd}
            />

            <div className="text-right font-mono text-xs whitespace-nowrap">
              <span className={cn("font-semibold", digest.releases > 0 ? "text-foreground" : "text-muted-foreground")}>
                {digest.releases}
              </span>
              <span className="block text-[10px] text-muted-foreground">
                release{digest.releases === 1 ? "" : "s"}
              </span>
            </div>
          </div>
        ))}
    </div>
  )
}
