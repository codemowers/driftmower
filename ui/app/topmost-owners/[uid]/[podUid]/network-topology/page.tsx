"use client"

import { useParams } from "next/navigation"
import { useClusterState } from "@/lib/cluster/cluster-state"
import NetworkTopologyHeader from "./components/network-topology-header"
import NetworkTopologyGraph from "./components/network-topology-graph"

export default function PodNetworkTopologyPage() {
  const { uid: workloadUid, podUid } = useParams<{ uid: string; podUid: string }>()
  const data = useClusterState(s => s.data)
  const reportId = useClusterState(s => s.reportId)
  const clusterResources = useClusterState(s => s.clusterResources)

  const pod = clusterResources?.find(r => r.uid === podUid && r.kind === "Pod") ?? null

  const workloadMatch = data
    ? Object.entries(data.report.workloadGroupMap).find(
        ([, usages]) => usages[0]?.workloadRootInfo?.uid === workloadUid,
      )
    : undefined

  if (!data || !pod || !workloadMatch) {
    return (
      <div className="min-h-full flex flex-col items-center">
        <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
          <p className="text-sm text-muted-foreground">Pod not found</p>
        </main>
      </div>
    )
  }

  const [, workloadUsages] = workloadMatch
  const workloadRoot = workloadUsages[0]?.workloadRootInfo
  const workloadName = workloadRoot?.name ?? "—"
  const workloadKind = workloadRoot?.kind ?? "—"

  return (
    <div className="flex min-h-full flex-col">
      <main className="flex w-full min-h-0 flex-1 flex-col gap-6 px-7 py-8">
        <NetworkTopologyHeader
          reportId={reportId}
          workloadUid={workloadUid}
          workloadName={workloadName}
          workloadKind={workloadKind}
          podUid={podUid}
          podName={pod.name}
          namespace={pod.namespace}
          nodeName={pod.nodeName ?? null}
          podIPs={pod.ips ?? []}
        />
        <div className="min-h-0 flex-1">
          <NetworkTopologyGraph podName={pod.name} podNamespace={pod.namespace} podIPs={pod.ips ?? []} />
        </div>
      </main>
    </div>
  )
}
