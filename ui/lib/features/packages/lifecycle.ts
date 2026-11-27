import type { Lifecycle } from "./types.ts"
export type LifecycleState="supported"|"end-of-life"|"unknown"
export const LIFECYCLE_STATES: {value:LifecycleState;label:string}[]=[{value:"supported",label:"Supported"},{value:"end-of-life",label:"EOL reached"},{value:"unknown",label:"Unknown"}]
export function lifecycleState(value?:Lifecycle):LifecycleState {return value?.state==="end-of-life"?"end-of-life":value?.state==="supported"||value?.state==="maintenance"?"supported":"unknown"}
export function dateValue(value?:string){if(!value||!/^\d{4}-\d{2}-\d{2}$/.test(value))return undefined;const ms=Date.parse(value+"T00:00:00Z");return Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,10)===value?ms:undefined}
export function lifecycleTimeline(value:Lifecycle,now=Date.now()){
 const released=dateValue(value.released),eol=dateValue(value.eol),active=dateValue(value.activeSupportEnd)
 if(released===undefined)return undefined
 if(eol!==undefined&&eol<released||active!==undefined&&active<released||active!==undefined&&eol!==undefined&&active>eol)return undefined
 const latest=Math.max(now,released,active??released,eol??released),span=Math.max(latest-released,86_400_000*30),end=latest+span*.12,start=released-span*.02
 const position=(date:number)=>Math.max(0,Math.min(100,(date-start)/(end-start)*100))
 const boundaries=[released,...active!==undefined?[active]:[],...eol!==undefined?[eol]:[],end].sort((a,b)=>a-b)
 const segments=boundaries.slice(0,-1).map((date,i)=>({start:position(date),end:position(boundaries[i+1]),phase:eol!==undefined&&date>=eol?"eol":active!==undefined&&date>=active?"maintenance":"active"}))
 return {segments,today:position(now),released:position(released),active:active===undefined?undefined:position(active),eol:eol===undefined?undefined:position(eol)}
}
