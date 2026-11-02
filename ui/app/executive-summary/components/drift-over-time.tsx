"use client"

import { useMemo } from "react"
import DriftAreaChart from "@/app/components/drift-history/drift-area-chart"
import { StatCaption, StatCell, StatGrid, StatValue } from "@/app/components/stats-card"
import { clusterStack, clusterStats, groupBy, sparklines } from "@/lib/features/drift-history/aggregate"
import { dayCount, percentLabel, windowSummary } from "@/lib/features/drift-history/format"
import { BULK_RESOLUTION } from "@/lib/features/drift-history/build-series"
import { useDriftHistory } from "@/lib/features/drift-history/use-drift-history"
import { cn } from "@/lib/utils/cn"
import type { ReportReadiness } from "@/lib/cluster/report-readiness"

export default function DriftOverTime({ readiness }: { readiness: ReportReadiness }) {
  const { data: history, loading } = useDriftHistory()

  // Grouped by workload, not by series, so the ratio agrees with the History lens.
  const data = useMemo(() => {
    if (!history) return null
    const { window, sources } = history
    const perWorkload = sparklines(
      groupBy(sources, source => source.workloadGroupKey),
      window.timeline,
      window.windowStart,
      window.windowEnd,
      BULK_RESOLUTION,
    )

    return {
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      reportCount: history.reportCount,
      stack: clusterStack(sources, window.windowStart, window.windowEnd),
      stats: clusterStats(perWorkload),
    }
  }, [history])

  if (!data) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-6">
        <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Drift over time</p>
        <p className="mt-2 text-sm text-muted-foreground">Reading drift history across every report...</p>
      </div>
    )
  }
  if (data.stack.length === 0) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-6">
        <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Drift over time</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {readiness === "unresolved"
            ? "Drift history needs at least one resolvable version."
            : "No drift history recorded yet."}
        </p>
      </div>
    )
  }

  const { stats } = data
  const containers = data.stack[data.stack.length - 1]?.total ?? 0
  const spanDays = Math.round((data.windowEnd - data.windowStart) / 86_400_000)

  return (
    <div className={cn("flex flex-col gap-5", loading && "opacity-60")}>
      <div className="rounded-xl border border-gray-200 bg-white p-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Drift over time</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {containers} containers tracked · {windowSummary(data)}
            </p>
          </div>
        </div>

        <DriftAreaChart stack={data.stack} />
      </div>

      <StatGrid>
        <StatCell label="Mean time to update">
          <StatValue>{dayCount(stats.meanTimeToUpdateDays)}</StatValue>
          <StatCaption>
            {stats.updateCount === 0
              ? "no updates completed in window"
              : `across ${stats.updateCount} completed update${stats.updateCount === 1 ? "" : "s"}`}
          </StatCaption>
        </StatCell>

        <StatCell label="Time spent green">
          <StatValue className={stats.greenRatio !== null && stats.greenRatio >= 0.8 ? "text-status-ok-label" : undefined}>
            {percentLabel(stats.greenRatio)}
          </StatValue>
          <StatCaption>of workload-days over {spanDays} days</StatCaption>
        </StatCell>

        <StatCell label="Longest unpatched streak">
          <StatValue className={stats.longestBehindStreakDays > 0 ? "text-status-major-label" : undefined}>
            {dayCount(stats.longestBehindStreakDays)}
          </StatValue>
          <StatCaption>
            {stats.longestBehindSeries ??
              (stats.longestBehindCount === 0
                ? "nothing behind"
                : `${stats.longestBehindCount} workloads tied`)}
          </StatCaption>
        </StatCell>

        <StatCell label="Improved vs regressed">
          <StatValue>
            <span className="text-status-ok-label">{stats.improved} &uarr;</span>
            <span className="text-muted-foreground"> / </span>
            <span className="text-status-major-label">{stats.regressed} &darr;</span>
          </StatValue>
          <StatCaption>of {stats.seriesCount} workloads vs {spanDays} days ago</StatCaption>
        </StatCell>
      </StatGrid>
    </div>
  )
}
