"use client"
import Card from "@/app/components/layout/card"

import {summaryAxisTime} from "@/lib/features/drift-history/time-window"
import TimeSeriesChart from "@/app/components/time-series-chart"
import {ChartTooltipContent} from "@/components/ui/chart"
import {useSignalHistory} from "@/lib/features/drift-history/use-signal-history"
import {currentSignal,signalPoints} from "@/lib/features/drift-history/signals"

export default function TechnicalDebtEstimate({hours:windowHours}:{hours:number}){
 const result=useSignalHistory("technical_debt",windowHours)
 const hours=currentSignal(result.data,"hours")
 const unknown=currentSignal(result.data,"unknown")
 return <Card title="Technical debt estimate" meta="estimated upgrade effort">
  <p className="text-4xl font-semibold tabular-nums text-brand-text">{hours===null?"—":`~${hours.toLocaleString(undefined,{maximumFractionDigits:1})}h${unknown!==null&&unknown>0?" + unknown":""}`}</p>
  {result.loading&&<p className="text-sm text-muted-foreground">Calculating historical estimate…</p>}
  {result.error&&<p role="alert" className="text-sm text-status-major-label">Estimate unavailable: {result.error} <button onClick={result.retry} className="underline">Retry</button></p>}
  {result.data&&!result.data.series.some(series=>series.name==="hours"&&series.values.length)&&<p className="text-sm text-muted-foreground">No historical observations available yet.</p>}
  {result.data&&result.data.series.some(series=>series.name==="hours"&&series.values.length>0)&&<TimeSeriesChart data={signalPoints(result.data,["hours"])} config={{hours:{label:"Estimated hours",color:"var(--chart-1)"}}} axes className="h-32" domain={[0,"auto"]} axisFormatter={time=>summaryAxisTime(time,windowHours)} series={[{key:"hours",name:"hours",fill:"var(--color-brand-bg)",stroke:"var(--chart-1)",curve:"stepAfter"}]} tooltip={<ChartTooltipContent labelFormatter={(_,payload)=>new Date(payload?.[0]?.payload?.t??0).toLocaleString()}/>}/>}
  <p className="text-xs text-muted-foreground">Uses version drift, falling back to declared image build age, taking the highest image estimate per workload × {result.data?.hoursPerUpgrade??"—"} hours per upgrade.</p>
  {result.data?.warnings.map(warning=><p key={warning} className="mt-2 text-xs text-status-minor-label">{warning}</p>)}
 </Card>
}
