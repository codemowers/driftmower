import { callTool } from "@/browser/connection"
import { useClusterState } from "./cluster-state"
import { presentationData, type DashboardSnapshot } from "@/browser/snapshot"

export async function fetchDynamicData(_reportId?: string | null): Promise<void> {
 try {
  const snapshot=await callTool<DashboardSnapshot>("get_dashboard_snapshot")
  useClusterState.setState({data:presentationData(snapshot),reportId:null,clusterName:snapshot.clusterContext,clusterResources:snapshot.resources,error:null,lastRefreshed:new Date()})
 } catch(e) { useClusterState.setState({error:(e as Error).message,errorSource:"report"}) }
}
