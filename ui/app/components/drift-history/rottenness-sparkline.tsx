"use client"

import { ChartTooltipContent } from "@/components/ui/chart"
import { DRIFT_CHART_CONFIG } from "@/lib/features/drift-history/chart-config"
import { dayLabel, tooltipDate } from "@/lib/features/drift-history/format"
import type { RottennessPoint } from "@/lib/features/drift-history/types"

import TimeSeriesChart from "../time-series-chart"

const MIN_DOMAIN = 0.6
const HEADROOM = 1.3

export default function RottennessSparkline({ points }: { points: RottennessPoint[] }) {
  if (points.length < 2) return null

  const peak = points.reduce((high, point) => Math.max(high, point.score), 0)
  const spanDays = Math.round((points[points.length - 1].t - points[0].t) / 86_400_000)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-0.5">
      <TimeSeriesChart data={points} config={DRIFT_CHART_CONFIG} className="h-auto min-h-[72px] flex-1"
        domain={[0, Math.max(MIN_DOMAIN, peak * HEADROOM)]} tooltip={<ChartTooltipContent labelFormatter={tooltipDate} hideIndicator/>}
        series={[{key:"score",name:"rottenness",fill:"var(--color-brand-bg)",stroke:"var(--chart-1)"}]} />
      <div className="flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>{dayLabel(points[0].t)}</span>
        <span>{spanDays} days</span>
        <span>{dayLabel(points[points.length - 1].t)}</span>
      </div>
    </div>
  )
}
