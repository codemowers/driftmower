import { cn } from "@/lib/utils/cn"
import { usageBarColor } from "@/lib/utils/usage-color"

type Segment = { key:string; value:number; color:string }

// Shared geometry for capacity gauges and comparison bars. Capacity uses one
// semantic threshold palette; multi-series comparisons supply category colors.
export default function MetricBar({ value=0, total, segments, color, className, label }: {
  value?:number;total:number;segments?:Segment[];color?:string;className?:string;label?:string
}) {
 const parts=segments??[{key:"usage",value,color:color??usageBarColor(total>0?value/total:0)}]
 let remaining=100
 const widths=[]
 for(const part of parts){
  const width=Math.min(remaining,Math.max(0,total>0?part.value/total*100:0))
  remaining-=width
  widths.push({...part,width})
 }
 return <div className={cn("flex h-2 w-full overflow-hidden rounded-full bg-muted",className)} role={label?"img":undefined} aria-label={label}>
   {widths.map(part=><div key={part.key} className={cn("h-full shrink-0",part.color)} style={{width:`${part.width}%`}} />)}
 </div>
}
