"use client"

import { useParams } from "next/navigation"
import Breadcrumbs from "@/app/components/breadcrumbs"
import ClusterDataPending from "@/app/components/cluster-data-pending"
import LogsTab from "@/app/topmost-owners/[uid]/[podUid]/components/logs-tab"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useContextHref } from "@/lib/hooks/use-context-href"

// One Pod's logs, with its containers' restarts marked.
export default function PodLogsPage() {
  const { uid, podUid } = useParams<{ uid: string; podUid: string }>()
  const clusterResources = useClusterState(s => s.clusterResources)
  const { linkTo } = useContextHref()
  const pod = clusterResources?.find(r => r.uid === podUid && r.kind === "Pod")

  return (
    <div className="flex h-full flex-col">
      <main className="flex min-h-0 w-full flex-1 flex-col gap-4 px-7 py-6">
        {clusterResources === null ? <ClusterDataPending /> : !pod ? <p className="text-sm text-muted-foreground">Pod not found</p> : (
          <>
            <Breadcrumbs items={[
              { label: "Workloads", href: linkTo("/topmost-owners") },
              { label: `Namespace ${pod.namespace}`, href: linkTo(`/namespaces/${encodeURIComponent(pod.namespace)}`) },
              { label: "Workload", href: linkTo(`/topmost-owners/${uid}`) },
              { label: `Pod ${pod.name}`, href: linkTo(`/topmost-owners/${uid}/${podUid}`) },
              { label: "Logs" },
            ]} />
            <LogsTab namespace={pod.namespace} workloadUid={uid} pod={pod} />
          </>
        )}
      </main>
    </div>
  )
}
