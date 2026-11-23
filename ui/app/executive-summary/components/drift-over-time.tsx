"use client"
import Card from "@/app/components/layout/card"
import TimeSeriesChart from "@/app/components/time-series-chart"
import { ChartTooltipContent } from "@/components/ui/chart"
import { signalPoints, type SignalHistory } from "@/lib/features/drift-history/signals"
import { BAND_STYLE } from "@/lib/features/drift-history/band-style"
import { summaryAxisTime } from "@/lib/features/drift-history/time-window"
import HistoryLegend from "@/app/components/drift-history/history-legend"

const classes = { unknown: "no_data", behind: "behind", major: "major_behind", minor: "minor_behind", patch: "patch_behind", current: "up_to_date" } as const
const keys: (keyof typeof classes)[] = ["current","patch","minor","major","behind","unknown"]
const config = Object.fromEntries(keys.map(key => [key,{label:BAND_STYLE[classes[key]].label,color:BAND_STYLE[classes[key]].fill}]))
export default function DriftOverTime({ state, hours }: { hours:number; state: { data?: SignalHistory; loading: boolean; error?: string; retry: () => void } }) {
  const { data, loading, error, retry } = state
  const hasSamples = data?.series.some(s => keys.includes(s.name as keyof typeof classes) && s.values.length)
  return <Card title="Drift over time" meta="containers">
    {error ? <p role="alert" className="text-sm text-status-major-label">Drift history unavailable: {error} <button className="underline" onClick={retry}>Retry</button></p>
      : !data ? <p className="text-sm text-muted-foreground">{loading ? "Reading drift history from Prometheus…" : "No drift history available."}</p>
      : !hasSamples ? <p className="text-sm text-muted-foreground">No historical samples yet. Missing data is unknown.</p>
      : <>
        <TimeSeriesChart data={signalPoints(data,keys)} config={config} axes axisFormatter={time=>summaryAxisTime(time,hours)} tooltip={<ChartTooltipContent labelFormatter={(_,payload)=>new Date(payload?.[0]?.payload?.t??0).toLocaleString()} />} series={keys.map(key => ({key,name:key,fill:BAND_STYLE[classes[key]].fill,stroke:BAND_STYLE[classes[key]].baseline,stack:"containers",curve:"stepAfter"}))} />
        <HistoryLegend showMarks={false} />
      </>}
    {data?.warnings.map(w => <p key={w} className="text-xs text-status-minor-label">{w}</p>)}
  </Card>
}
