"use client"

import type { ComponentProps } from "react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { DRIFT_CHART_CONFIG } from "@/lib/features/drift-history/chart-config"
import type { StackPoint, StackStatus } from "@/lib/features/drift-history/types"
import { axisDate, tooltipDate } from "@/lib/features/drift-history/format"
import { BAND_STYLE } from "@/lib/features/drift-history/band-style"
import HistoryLegend from "./history-legend"

const LAYERS: StackStatus[] = ["no_data", "behind", "major_behind", "minor_behind", "patch_behind", "up_to_date", "ahead"]

const PLOT_HEIGHT_PX = 222
const MIN_BAND_PX = 3

const plotKey = (status: StackStatus) => `${status}_plot`

function bandFloor(stack: StackPoint[]): number {
  const peak = stack.reduce((high, point) => Math.max(high, point.total), 0)
  return Math.ceil((peak * MIN_BAND_PX) / PLOT_HEIGHT_PX)
}

function countAt(row: unknown, status: unknown): number {
  const counts = row as Record<string, number> | undefined
  const value = counts?.[String(status)]
  return typeof value === "number" ? value : 0
}

function StackTooltip({ payload, ...props }: ComponentProps<typeof ChartTooltipContent>) {
  const rows = (payload ?? [])
    .map(item => ({ ...item, value: countAt(item.payload, item.name) }))
    .filter(item => item.value > 0)
    .reverse()

  if (rows.length === 0) return null

  const total = rows.reduce((sum, item) => sum + item.value, 0)

  return (
    <ChartTooltipContent
      {...props}
      payload={rows}
      labelFormatter={tooltipDate}
      footer={
        <>
          <span className="text-foreground">Total tracked</span>
          <span className="font-mono font-medium text-foreground tabular-nums">{total.toLocaleString()}</span>
        </>
      }
    />
  )
}

export default function DriftAreaChart({ stack }: { stack: StackPoint[] }) {
  if (stack.length === 0) return null

  const floor = bandFloor(stack)
  const rows = stack.map(point => ({
    t: point.t,
    ...point.counts,
    ...Object.fromEntries(
      LAYERS.map(status => [plotKey(status), point.counts[status] > 0 ? Math.max(point.counts[status], floor) : 0]),
    ),
  }))

  return (
    <div className="flex flex-col gap-3">
      <ChartContainer config={DRIFT_CHART_CONFIG} className="h-[260px] w-full">
        <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            domain={["dataMin", "dataMax"]}
            scale="time"
            tickFormatter={axisDate}
            tickLine={false}
            axisLine={false}
            minTickGap={72}
          />
          <YAxis tickLine={false} axisLine={false} width={48} allowDecimals={false} />
          <ChartTooltip isAnimationActive={false} position={{ y: 8 }} content={<StackTooltip />} />
          {LAYERS.map(status => (
            <Area
              key={status}
              dataKey={plotKey(status)}
              name={status}
              type="stepAfter"
              stackId="containers"
              fill={BAND_STYLE[status].fill}
              fillOpacity={1}
              stroke={BAND_STYLE[status].baseline}
              strokeWidth={1}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ChartContainer>
      <HistoryLegend showMarks={false} />
    </div>
  )
}
