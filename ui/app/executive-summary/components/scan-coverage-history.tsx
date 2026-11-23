"use client"
import Card from "@/app/components/layout/card"
import TimeSeriesChart from "@/app/components/time-series-chart"
import { ChartTooltipContent } from "@/components/ui/chart"
import { useSignalHistory } from "@/lib/features/drift-history/use-signal-history"
import { currentSignal, signalPoints } from "@/lib/features/drift-history/signals"
import { summaryAxisTime } from "@/lib/features/drift-history/time-window"

// Recharts stacks in series order; absent evidence stays above observed stages.
const definitions = [
 {key:"trivy_files",label:"Trivy + files",color:"var(--chart-1)"},
 {key:"files_only",label:"Files only",color:"var(--chart-2)"},
 {key:"trivy_only",label:"Trivy only (legacy)",color:"var(--chart-3)"},
 {key:"no_scan",label:"No scan",color:"var(--color-status-neutral-bg)"},
]
export default function ScanCoverageHistory({hours}:{hours:number}) {
 const result=useSignalHistory("scan_coverage",hours)
 const visible=definitions.filter(d=>d.key!=="trivy_only"||result.data?.series.some(s=>s.name===d.key&&s.values.some(([,v])=>v>0)))
 const keys=visible.map(d=>d.key)
 const hasSamples=result.data?.series.some(s=>keys.includes(s.name)&&s.values.length>0)
 const config=Object.fromEntries(visible.map(d=>[d.key,{label:d.label,color:d.color}]))
 return <Card title="Image scan coverage" meta="images">
  <div className="flex flex-wrap gap-5">{visible.map(d=><div key={d.key}>
   <p className="text-xs text-muted-foreground">{d.label}</p>
   <p className="text-2xl font-semibold tabular-nums">{currentSignal(result.data,d.key)?.toLocaleString()??"—"}</p>
  </div>)}</div>
  {result.loading&&<p className="text-sm text-muted-foreground">Loading scan coverage…</p>}
  {result.error&&<p role="alert" className="text-sm text-status-major-label">Scan coverage unavailable: {result.error} <button className="underline" onClick={result.retry}>Retry</button></p>}
  {result.data&&!hasSamples&&<p className="text-sm text-muted-foreground">Scan coverage observations are unavailable. Missing data is unknown.</p>}
  {result.data&&hasSamples&&<TimeSeriesChart data={signalPoints(result.data,keys)} config={config} axes domain={[0,"auto"]} className="h-44" axisFormatter={time=>summaryAxisTime(time,hours)} series={visible.map(d=>({key:d.key,name:d.key,fill:d.color,stroke:d.color,stack:"images",curve:"stepAfter"}))} tooltip={<ChartTooltipContent labelFormatter={(_,payload)=>new Date(payload?.[0]?.payload?.t??0).toLocaleString()}/>}/>}
  <p className="text-xs text-muted-foreground">Distinct running image digests, counted once across containers and namespaces; Trivy results may be partial, with Java archive coverage excluded.</p>
  {result.data?.warnings.map(w=><p key={w} className="text-xs text-status-minor-label">{w}</p>)}
 </Card>
}
