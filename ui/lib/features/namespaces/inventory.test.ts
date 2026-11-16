import assert from "node:assert/strict"
import test from "node:test"
import { namespaceWorkloadRoots,isTerminalPod } from "./inventory.ts"
import type { Report } from "../../cluster/reports"
import type { ClusterResource } from "../../cluster/cluster-state"

test("namespace views exclude image owners and terminal Pods while keeping unhealthy live workloads",()=>{
 const root=(kind:string,uid:string,extra:object={})=>({kind,uid,name:uid,namespace:"team",...extra})
 const pod=(uid:string,phase:string,ownerUID?:string)=>({...root("Pod",uid),phase,ownerUID} as ClusterResource)
 const data={workloads:[root("ContainerImage","scan"),root("Namespace","namespace:team",{standalonePods:[{name:"done",uid:"done"},{name:"failed",uid:"failed"},{name:"crashing",uid:"crashing"},{name:"unknown",uid:"unknown"}]}),root("Job","finished-job",{completed:true}),root("Job","failed-job"),root("Deployment","broken-deployment"),root("Deployment","scaled-zero",{desiredReplicas:0})],report:{workloadGroupMap:{}}} as unknown as Report
 const crashing={...pod("crashing","Running"),podStatus:{display:"CrashLoopBackOff",ready:false}}
 const resources=[pod("done","Succeeded"),pod("failed","Failed"),crashing,pod("job-pod","Failed","failed-job"),pod("deployment-pod","Failed","broken-deployment")] as ClusterResource[]
 assert.deepEqual(namespaceWorkloadRoots(data,resources).map(root=>root.uid),["crashing","unknown","failed-job","broken-deployment","scaled-zero"])
 assert.equal(isTerminalPod(crashing as ClusterResource),false)
 assert.equal(data.workloads?.length,6)
})
