"use client"

import HistoryLegend from "@/app/components/drift-history/history-legend"
import DriftTimelineRow from "@/app/components/drift-history/drift-timeline-row"
import TimelineDateAxis from "@/app/components/drift-history/timeline-date-axis"
import { windowSummary } from "@/lib/features/drift-history/format"
import { useImageSeries } from "@/lib/features/drift-history/use-drift-history"
import { cn } from "@/lib/utils/cn"

export default function HistoryCard({ imageKey }: { imageKey: string }) {
  const { data, loading, error } = useImageSeries(imageKey)

  if (error) {
    return (
      <div className="rounded-xl border border-gray-200 p-4">
        <p className="text-xs text-muted-foreground">Drift history is unavailable.</p>
      </div>
    )
  }
  if (!data) {
    return (
      <div className="rounded-xl border border-gray-200 p-4">
        <p className="text-xs text-muted-foreground">Loading drift history...</p>
      </div>
    )
  }
  if (data.series.length === 0) return null

  return (
    <div className={cn("overflow-hidden rounded-xl border border-gray-200", loading && "opacity-60")}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 bg-gray-50 px-4 py-3">
        <div>
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Drift over time</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {data.series.length} workload{data.series.length === 1 ? "" : "s"} · {windowSummary(data)}
          </p>
        </div>
      </div>

      <div className="px-4 py-2">
        {data.series.map(s => (
          <DriftTimelineRow
            key={s.key}
            series={s}
            title={s.workloadName}
            subtitle={`${s.workloadKind} · ${s.workloadNamespace}`}
            windowStart={data.windowStart}
            windowEnd={data.windowEnd}
          />
        ))}
        <TimelineDateAxis series={data.series} windowStart={data.windowStart} windowEnd={data.windowEnd} />
        <HistoryLegend />
      </div>
    </div>
  )
}
