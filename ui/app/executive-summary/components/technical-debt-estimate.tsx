"use client"

import {useState,type FormEvent} from "react"
import TimeSeriesChart from "@/app/components/time-series-chart"
import {ChartTooltipContent} from "@/components/ui/chart"
import {useSignalHistory} from "@/lib/features/drift-history/use-signal-history"
import {currentSignal,signalPoints} from "@/lib/features/drift-history/signals"

export default function TechnicalDebtEstimate(){
 const [assumptions,setAssumptions]=useState({hours:1,days:365})
 const result=useSignalHistory("technical_debt",assumptions.hours,assumptions.days)
 const hours=currentSignal(result.data,"hours")
 const unknown=currentSignal(result.data,"unknown")
 const fallback=currentSignal(result.data,"build_age_fallback")
 const backlog=currentSignal(result.data,"version_backlog")
 const apply=(event:FormEvent<HTMLFormElement>)=>{
  event.preventDefault()
  const values=new FormData(event.currentTarget)
  setAssumptions({hours:Number(values.get("hours")),days:Number(values.get("days"))})
 }
 return <section className="rounded-xl border border-gray-200 bg-white p-6">
  <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Technical debt estimate</h2><p className="mt-2 text-sm text-muted-foreground">Estimated upgrade effort · 90-day history</p></div><p className="text-4xl font-semibold tabular-nums text-brand-text">{hours===null?"—":`~${hours.toLocaleString(undefined,{maximumFractionDigits:1})}h${unknown!==null&&unknown>0?" + unknown":""}`}</p></div>
  <form onSubmit={apply} className="my-5 flex flex-wrap items-end gap-4 text-xs text-muted-foreground">
   <label className="flex flex-col gap-1">Hours per upgrade<input className="w-28 rounded border px-2 py-1.5 text-foreground" name="hours" type="number" min="0.01" max="10000" step="0.01" defaultValue={assumptions.hours} required/></label>
   <label className="flex flex-col gap-1">Build-age days per upgrade<input className="w-36 rounded border px-2 py-1.5 text-foreground" name="days" type="number" min="1" max="36500" step="1" defaultValue={assumptions.days} required/></label>
   <button className="rounded border px-3 py-1.5 text-foreground hover:bg-brand-bg">Recalculate history</button>
  </form>
  {result.loading&&<p className="text-sm text-muted-foreground">Calculating historical estimate…</p>}
  {result.error&&<p role="alert" className="text-sm text-status-major-label">Estimate unavailable: {result.error} <button onClick={result.retry} className="underline">Retry</button></p>}
  {result.data&&!result.data.series.some(series=>series.name==="hours"&&series.values.length)&&<p className="text-sm text-muted-foreground">No historical observations available yet.</p>}
  {result.data&&result.data.series.some(series=>series.name==="hours"&&series.values.length>0)&&<TimeSeriesChart data={signalPoints(result.data,["hours"])} config={{hours:{label:"Estimated hours",color:"var(--chart-1)"}}} axes className="h-56" domain={[0,"auto"]} axisFormatter={time=>new Date(time).toLocaleDateString(undefined,{month:"short",day:"numeric"})} series={[{key:"hours",name:"hours",fill:"var(--color-brand-bg)",stroke:"var(--chart-1)",curve:"stepAfter"}]} tooltip={<ChartTooltipContent labelFormatter={(_,payload)=>new Date(payload?.[0]?.payload?.t??0).toLocaleString()}/>}/>}
  <p className="mt-3 text-xs text-muted-foreground">{backlog??"—"} workloads behind known versions · {fallback??"—"} workloads using build age · {unknown??"—"} workloads with incomplete estimates.</p>
  <p className="mt-2 text-xs text-muted-foreground">A known outdated version counts as one upgrade. When version comparison is unavailable, image age ÷ {assumptions.days} days supplies upgrade units. Each workload uses its highest image estimate, multiplied by {assumptions.hours} hours. Workload categories can overlap.</p>
  <p className="mt-2 text-xs text-muted-foreground">Uses declared image build timestamps. Missing version and build time stays unknown. These assumptions recalculate past observations; estimated effort is not measured work time.</p>
  {result.data?.warnings.map(warning=><p key={warning} className="mt-2 text-xs text-status-minor-label">{warning}</p>)}
 </section>
}
