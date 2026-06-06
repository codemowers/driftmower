"use client"

import { useParams } from "next/navigation"
import { useClusterState } from "@/lib/cluster/cluster-state"
import NetworkTopologyClient from "./components/network-topology-client"

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
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
        <NetworkTopologyClient
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
      </main>
    </div>
  )
}
