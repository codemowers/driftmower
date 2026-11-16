export type FiringAlert={
 alertname:string;severity:string;namespace?:string;startsAt:string;summary?:string;description?:string
 labels:Record<string,string>;fingerprint:string;silencedBy:string[];inhibitedBy:string[]
}
const rank=(severity:string)=>({critical:0,warning:1,info:2}[severity]??3)
export function alertActions(alerts:FiringAlert[],namespaces:string[]|null){
 const allowed=namespaces?new Set(namespaces):null
 const groups=new Map<string,FiringAlert[]>()
 for(const alert of alerts){
  if(alert.silencedBy.length||alert.inhibitedBy.length||(allowed&&!allowed.has(alert.namespace??"")))continue
  const l=alert.labels
  const entity=l.digest?`image/${l.digest}`:l.serviceaccount?`sa/${l.serviceaccount}`:l.persistentvolumeclaim?`pvc/${l.persistentvolumeclaim}`:l.persistentvolume?`pv/${l.persistentvolume}`:l.pod?`pod/${l.pod}`:l.node?`node/${l.node}`:l.registry?`registry/${l.registry}`:`${alert.alertname}/${l.instance??""}`
  const key=JSON.stringify([alert.namespace??"",entity])
  const group=groups.get(key)??[];group.push(alert);groups.set(key,group)
 }
 const compare=(a:FiringAlert,b:FiringAlert)=>rank(a.severity)-rank(b.severity)||a.startsAt.localeCompare(b.startsAt)||a.alertname.localeCompare(b.alertname)
 return [...groups].map(([key,alerts])=>({key,alerts:alerts.sort(compare)})).sort((a,b)=>compare(a.alerts[0],b.alerts[0])||a.key.localeCompare(b.key))
}
export function alertHref(alert:FiringAlert){
 const ns=encodeURIComponent(alert.namespace??""),l=alert.labels
 if(l.serviceaccount&&ns)return `/service-accounts/${ns}/${encodeURIComponent(l.serviceaccount)}`
 if(l.persistentvolumeclaim&&ns)return `/volumes/pvc/${ns}/${encodeURIComponent(l.persistentvolumeclaim)}`
 if(l.persistentvolume)return `/volumes/pv/${encodeURIComponent(l.persistentvolume)}`
 if(l.digest)return "/vulnerabilities"
 if(l.registry)return "/base-images"
 if(alert.alertname.startsWith("DriftmowerAdvisory")||alert.alertname==="DriftmowerCrawlerInventoryUnavailable")return "/source-repositories"
 return ns?`/namespaces/${ns}`:"/cluster"
}
