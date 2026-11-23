"use client"
import Page from "@/app/components/layout/page"

import { useParams } from "next/navigation"
import { useClusterState } from "@/lib/cluster/cluster-state"
import NetworkTopologyHeader from "./components/network-topology-header"
import { PodNav } from "@/app/components/layout/resource-navs"
import NetworkTopologyGraph from "./components/network-topology-graph"
import { NetstatdMissingNotice } from "@/app/components/netstatd-missing"
import { useNetstatdMissing } from "@/lib/features/netstatd"

export default function PodNetworkTopologyPage() {
  const { uid: workloadUid, podUid } = useParams<{ uid: string; podUid: string }>()
  const data = useClusterState(s => s.data)
  const clusterResources = useClusterState(s => s.clusterResources)
  const missing = useNetstatdMissing()

  const pod = clusterResources?.find(r => r.uid === podUid && r.kind === "Pod") ?? null

  const workloadMatch = data
    ? Object.entries(data.report.workloadGroupMap).find(
        ([, usages]) => usages[0]?.workloadRootInfo?.uid === workloadUid,
      )
    : undefined

  if (!data || !pod || !workloadMatch) {
    return (
      <div className="min-h-full flex flex-col items-center">
        <Page>
          <p className="text-sm text-muted-foreground">Pod not found</p>
        </Page>
      </div>
    )
  }

  const [, workloadUsages] = workloadMatch
  const workloadRoot = workloadUsages[0]?.workloadRootInfo
  const workloadName = workloadRoot?.name ?? "—"
  const workloadKind = workloadRoot?.qualifiedKind ?? workloadRoot?.kind ?? "—"

  return (
    <div className="flex min-h-full flex-col">
      <Page fill>
        <NetworkTopologyHeader
          workloadUid={workloadUid}
          workloadName={workloadName}
          workloadKind={workloadKind}
          podUid={podUid}
          podName={pod.name}
          namespace={pod.namespace}
          nodeName={pod.nodeName ?? null}
          podIPs={pod.ips ?? []}
        />
        <PodNav workloadUid={workloadUid} podUid={podUid} namespace={pod.namespace} pod={pod.name} />
        {missing ? (
          <NetstatdMissingNotice />
        ) : (
          <div className="min-h-0 flex-1">
            <NetworkTopologyGraph podName={pod.name} podNamespace={pod.namespace} podIPs={pod.ips ?? []} />
          </div>
        )}
      </Page>
    </div>
  )
}
