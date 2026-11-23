import { callTool } from "./connection"

export function callRegistry<T>(name:string,args:Record<string,unknown>={},signal?:AbortSignal):Promise<T>{return callTool<T>(name,args,signal)}

// Observed versions and image associations belong to the selected cluster.
// Its MCP combines that inventory with the local crawler's fetched evidence.
export async function sourceFindings<T extends {sources:unknown[];missing?:string[]}>(args:Record<string,unknown>={},signal?:AbortSignal):Promise<T>{
 type Version={version:string;images?:string[];references?:string[];versionStatus?:unknown;findings?:{advisory:string;summary?:string;url?:string}[]}
 const result=await callTool<{sources:({url:string;latest?:string;deployed:Version[]}&Record<string,unknown>)[];warnings?:string[]}>("get_source_findings",args.url?{url:args.url}:{},signal)
 return {...result,sources:result.sources.map(source=>({...source,latest:source.latest?{tag:source.latest}:undefined,deployed:source.deployed.map(version=>({...version,images:version.images??[],references:version.references??[]})),advisories:source.deployed.flatMap(version=>(version.findings??[]).map(finding=>({id:finding.advisory,summary:finding.summary,url:finding.url})))}))} as T
}

export async function sourceImages(url:string,signal?:AbortSignal):Promise<import("@/lib/features/crawler/sources").SourceImages>{
 return callTool("list_source_images",{url},signal)
}
