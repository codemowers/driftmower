export type SignalHistory = {
 signal:string;query:string;start:number;end:number;stepSeconds:number
 hoursPerUpgrade?:number;buildAgeDaysPerUpgrade?:number
 series:{name:string;values:[number,number][]}[];warnings:string[]
}

// Missing samples remain null. Formatting a chart never fills a data gap with
// zero or carries an obsolete observation forward as a current estimate.
export function signalPoints(history:SignalHistory,keys:string[]){
 const rows=new Map<number,Record<string,number|null>>()
 for(let t=history.start;t<=history.end;t+=history.stepSeconds){
  rows.set(t,{t:t*1000,...Object.fromEntries(keys.map(key=>[key,null]))})
 }
 for(const series of history.series){
  if(!keys.includes(series.name))continue
  for(const [time,value] of series.values){const row=rows.get(time);if(row)row[series.name]=value}
 }
 return [...rows.values()]
}
export function currentSignal(history:SignalHistory|undefined,name:string):number|null{
 return history?.series.find(series=>series.name===name)?.values.find(([time])=>time===history.end)?.[1]??null
}
