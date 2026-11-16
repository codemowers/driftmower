export type ScanStatus={status:string;done:number;pending:number;running:number;failed:number;total:number;reason?:string}
export function imageScanBadge(digests:string[],statuses:Record<string,ScanStatus>){
 const unique=[...new Set(digests)]
 const rows=unique.map(digest=>statuses[digest])
 const done=rows.filter(row=>row?.status==="done").length
 let status="pending"
 if(!rows.length||rows.some(row=>!row))status="unavailable"
 else if(done===rows.length)status="done"
 else if(rows.some(row=>row.status==="failed"))status="failed"
 else if(rows.some(row=>row.status==="running"))status="running"
 else if(rows.some(row=>row.status==="unavailable"))status="unavailable"
 else if(done>0||rows.some(row=>row.status==="partial"))status="partial"
 const title=unique.slice(0,10).map((digest,i)=>`${digest}: ${rows[i]?.status??"unavailable"}${rows[i]?.total?` · ${rows[i].done}/${rows[i].total} platforms done`:""}${rows[i]?.reason?` · ${rows[i].reason}`:""}`).join("\n")
 return {status,done,total:rows.length,title:title+(unique.length>10?`\n… ${unique.length-10} more digests`:"")}
}
