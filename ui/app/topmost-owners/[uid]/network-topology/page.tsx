"use client"

import { useParams } from "next/navigation"
import { useClusterState } from "@/lib/cluster/cluster-state"
import NetworkTopologyClient from "./components/network-topology-client"

export default function NetworkTopologyPage() {
  const { uid } = useParams<{ uid: string }>()
  const data = useClusterState(s => s.data)
  const reportId = useClusterState(s => s.reportId)

  const match = data
    ? Object.entries(data.report.workloadGroupMap).find(
        ([, usages]) => usages[0]?.workloadRootInfo?.uid === uid,
      )
    : undefined

  if (!data || !match) {
    return (
      <div className="min-h-full flex flex-col items-center">
        <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
          <p className="text-sm text-muted-foreground">Workload not found</p>
        </main>
      </div>
    )
  }

  const [groupKey] = match
  const [kind, namespace, name] = groupKey.split("/")

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
        <NetworkTopologyClient
          uid={uid}
          reportId={reportId}
          kind={kind}
          namespace={namespace}
          name={name}
        />
      </main>
    </div>
  )
}
