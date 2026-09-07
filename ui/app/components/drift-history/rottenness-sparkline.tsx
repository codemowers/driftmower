"use client"

import { Area, AreaChart, YAxis } from "recharts"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { DRIFT_CHART_CONFIG } from "@/lib/features/drift-history/chart-config"
import { dayLabel, tooltipDate } from "@/lib/features/drift-history/format"
import type { RottennessPoint } from "@/lib/features/drift-history/types"

const MIN_DOMAIN = 0.6
const HEADROOM = 1.3

export default function RottennessSparkline({ points }: { points: RottennessPoint[] }) {
  if (points.length < 2) return null

  const peak = points.reduce((high, point) => Math.max(high, point.score), 0)
  const spanDays = Math.round((points[points.length - 1].t - points[0].t) / 86_400_000)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-0.5">
      <ChartContainer config={DRIFT_CHART_CONFIG} className="aspect-auto min-h-[72px] w-full flex-1">
        <AreaChart data={points} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
          <YAxis hide domain={[0, Math.max(MIN_DOMAIN, peak * HEADROOM)]} />
          <ChartTooltip
            isAnimationActive={false}
            cursor={{ stroke: "var(--color-border)" }}
            content={<ChartTooltipContent labelFormatter={tooltipDate} hideIndicator />}
          />
          <Area
            dataKey="score"
            name="rottenness"
            type="monotone"
            fill="var(--color-brand-bg)"
            fillOpacity={1}
            stroke="var(--color-brand)"
            strokeWidth={1.5}
            activeDot={{ r: 3, fill: "var(--color-brand)", strokeWidth: 0 }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ChartContainer>
      <div className="flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>{dayLabel(points[0].t)}</span>
        <span>{spanDays} days</span>
        <span>{dayLabel(points[points.length - 1].t)}</span>
      </div>
    </div>
  )
}
