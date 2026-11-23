"use client"
import Page from "@/app/components/layout/page"

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
        <Page>
          <p className="text-sm text-muted-foreground">Workload not found</p>
        </Page>
      </div>
    )
  }

  const root = match[1][0]?.workloadRootInfo

  return (
    <div className="min-h-full flex flex-col items-center">
      <Page>
        <NetworkTopologyClient
          uid={uid}
          kind={root?.kind ?? ""}
          kindLabel={root?.qualifiedKind ?? root?.kind ?? ""}
          namespace={root?.namespace ?? ""}
          name={root?.name ?? ""}
        />
      </Page>
    </div>
  )
}
