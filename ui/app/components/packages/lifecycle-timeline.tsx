import type {Lifecycle} from "@/lib/features/packages/types"
import {lifecycleTimeline} from "@/lib/features/packages/lifecycle"
import {LifecycleLink} from "./evidence"

const phaseStyle={active:"bg-emerald-500",maintenance:"bg-amber-400",eol:"bg-red-500"}
export default function LifecycleTimeline({value,version}:{value?:Lifecycle;version:string}){
 const timeline=value?lifecycleTimeline(value):undefined
 const events=timeline?[{label:"Cycle released",date:value?.released,position:timeline.released},...(timeline.active===undefined?[]:[{label:"Active support ends",date:value?.activeSupportEnd,position:timeline.active}]),...(timeline.eol===undefined?[]:[{label:"EOL",date:value?.eol,position:timeline.eol}])]:[]
 const state=value?.state??"unknown"
 const label=state==="end-of-life"?"EOL reached":state==="maintenance"?"Maintenance support · upgrade recommended":state==="supported"?"Supported":"Lifecycle unknown"
 const tone=state==="end-of-life"?"text-red-700":state==="maintenance"?"text-amber-800":state==="supported"?"text-emerald-700":"text-muted-foreground"
 return <div className="border-b px-5 py-4 text-xs">
  <div className="flex flex-wrap items-center justify-between gap-2"><span className={`font-semibold ${tone}`}>{label}</span><LifecycleLink value={value}/></div>
  <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-muted-foreground">{[["bg-emerald-500","Active support"],["bg-amber-400","Maintenance / security support"],["bg-red-500","EOL reached"]].map(([color,text])=><span key={text} className="inline-flex items-center gap-1.5"><span className={`size-2 rounded-sm ${color}`}/>{text}</span>)}</div>
  {timeline?<div className="mt-6 mb-2" role="img" aria-label={`Lifecycle of installed version ${version}: ${label}. Today is marked against the published release cycle dates.`}>
   <div className="relative h-4 rounded bg-gray-100">{timeline.segments.map((segment,i)=><span key={i} className={`absolute inset-y-0 ${phaseStyle[segment.phase as keyof typeof phaseStyle]}`} style={{left:`${segment.start}%`,width:`${segment.end-segment.start}%`}}/>)}<span className="absolute -top-2 h-8 border-l-2 border-gray-900" style={{left:`${timeline.today}%`}}><span className="absolute bottom-full left-0 -translate-x-1/2 whitespace-nowrap pb-1 font-semibold text-foreground">Today · {version||"unknown version"}</span></span></div>
   <div className="relative mt-2 text-muted-foreground" style={{height:`${events.length*18}px`}}>{events.map((event,i)=><span key={event.label} className="absolute whitespace-nowrap" style={{top:`${i*18}px`,left:`${Math.max(1,Math.min(95,event.position))}%`,transform:event.position>50?"translateX(-100%)":"none"}}>{event.label} {event.date}</span>)}</div>
   {(!value?.activeSupportEnd||!value?.eol)&&<p className="mt-1 text-muted-foreground">{!value?.activeSupportEnd?"Active support end unknown. ":""}{!value?.eol?"EOL date not published.":""}</p>}
  </div>:<p className="mt-3 text-muted-foreground">Timeline dates unavailable.</p>}
  {value?.latest&&<p className="mt-2 text-muted-foreground">Latest on this cycle: <span className="font-mono">{value.latest}</span>. Cycle support does not establish whether this installed patch is current.</p>}
 </div>
}
