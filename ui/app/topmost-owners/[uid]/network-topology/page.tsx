"use client"

import { useParams } from "next/navigation"
import { useClusterState } from "@/lib/cluster/cluster-state"
import NetworkTopologyClient from "./components/network-topology-client"

export default function NetworkTopologyPage() {
  const { uid } = useParams<{ uid: string }>()
  const data = useClusterState(s => s.data)

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

  const root = match[1][0]?.workloadRootInfo

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
        <NetworkTopologyClient
          uid={uid}
          kind={root?.kind ?? ""}
          kindLabel={root?.qualifiedKind ?? root?.kind ?? ""}
          namespace={root?.namespace ?? ""}
          name={root?.name ?? ""}
        />
      </main>
    </div>
  )
}
