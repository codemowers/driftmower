"use client"

import type { ComponentProps, ReactElement } from "react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { cn } from "@/lib/utils/cn"

type Series = {
 key:string;name:string;fill:string;stroke:string;stack?:string
 curve?:ComponentProps<typeof Area>["type"]
}

// Shared axes, tooltip, responsive sizing and animation policy for metric and
// drift history. Domain-specific series and tooltip contents stay with callers.
export default function TimeSeriesChart({data,config,series,axes=false,domain,tooltip,axisFormatter,className}: {
 data:object[];config:ChartConfig;series:Series[];axes?:boolean
 domain?:ComponentProps<typeof YAxis>["domain"];tooltip?:ReactElement
 axisFormatter?:(value:number)=>string;className?:string
}){
 return <ChartContainer config={config} className={cn("aspect-auto h-[260px] w-full",className)}>
  <AreaChart data={data} margin={axes?{top:8,right:8,bottom:0,left:8}:{top:4,right:0,bottom:0,left:0}}>
   {axes&&<CartesianGrid vertical={false}/>}
   {axes&&<XAxis dataKey="t" type="number" domain={["dataMin","dataMax"]} scale="time" tickFormatter={axisFormatter} tickLine={false} axisLine={false} minTickGap={72}/>}
   <YAxis hide={!axes} domain={domain} tickLine={false} axisLine={false} width={48} allowDecimals={false}/>
   <ChartTooltip isAnimationActive={false} position={axes?{y:8}:undefined} cursor={{stroke:"var(--color-border)"}} content={tooltip??<ChartTooltipContent hideIndicator/>}/>
   {series.map(s=><Area key={s.key} dataKey={s.key} name={s.name} type={s.curve??"monotone"} stackId={s.stack} fill={s.fill} fillOpacity={1} stroke={s.stroke} strokeWidth={s.stack?1:1.5} activeDot={s.stack?false:{r:3,fill:s.stroke,strokeWidth:0}} isAnimationActive={false}/>)}
  </AreaChart>
 </ChartContainer>
}
