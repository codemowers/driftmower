"use client"

import HistoryLegend from "@/app/components/drift-history/history-legend"
import DriftTimelineRow from "@/app/components/drift-history/drift-timeline-row"
import TimelineDateAxis from "@/app/components/drift-history/timeline-date-axis"
import { percentLabel, windowSummary } from "@/lib/features/drift-history/format"
import { useWorkloadSeries } from "@/lib/features/drift-history/use-drift-history"
import { cn } from "@/lib/utils/cn"

export default function HistoryTab({ workloadGroupKey }: { workloadGroupKey: string }) {
  const { data, loading, error } = useWorkloadSeries(workloadGroupKey)

  if (error) return <p className="text-sm text-muted-foreground">Drift history is unavailable.</p>
  if (!data) return <p className="text-sm text-muted-foreground">Loading drift history...</p>

  const behind = data.series.filter(
    s => s.stats.currentStatus !== "up_to_date" && s.stats.currentStatus !== "ahead",
  )
  const worst = data.series.reduce<number | null>((low, s) => {
    if (s.stats.greenRatio === null) return low
    return low === null ? s.stats.greenRatio : Math.min(low, s.stats.greenRatio)
  }, null)

  return (
    <div className={cn("overflow-hidden rounded-xl border border-gray-200", loading && "opacity-60")}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 bg-gray-50 px-4 py-3">
        <div>
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Drift over time</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {behind.length} of {data.series.length} image{data.series.length === 1 ? "" : "s"} behind today
            {worst !== null && `, worst is ${percentLabel(worst)} green`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">{windowSummary(data)}</span>
        </div>
      </div>

      <div className="px-4 py-2">
        {data.series.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">No history recorded for this workload.</p>
        ) : (
          data.series.map(s => (
            <DriftTimelineRow
              key={s.key}
              series={s}
              title={s.repository}
              subtitle={`${s.registry} · ${s.containerCount} container${s.containerCount === 1 ? "" : "s"}`}
              windowStart={data.windowStart}
              windowEnd={data.windowEnd}
            />
          ))
        )}
        <TimelineDateAxis series={data.series} windowStart={data.windowStart} windowEnd={data.windowEnd} />
        <HistoryLegend />
      </div>
    </div>
  )
}
