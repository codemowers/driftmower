"use client"

import { useParams } from "next/navigation"
import Breadcrumbs from "@/app/components/breadcrumbs"
import PageLoading from "@/app/components/page-loading"
import LogsTab from "@/app/topmost-owners/[uid]/[podUid]/components/logs-tab"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { findWorkloadRoot } from "@/lib/cluster/workload-root"
import { useContextHref } from "@/lib/hooks/use-context-href"

// One workload's logs: every Pod and container, merged in time order.
export default function WorkloadLogsPage() {
  const { uid } = useParams<{ uid: string }>()
  const data = useClusterState(s => s.data)
  const clusterResources = useClusterState(s => s.clusterResources)
  const { linkTo } = useContextHref()
  if (!data) return <PageLoading loading="workload" />
  const info = Object.values(data.report.workloadGroupMap).find(usages => usages[0]?.workloadRootInfo?.uid === uid)?.[0]?.workloadRootInfo
  const root = info ? findWorkloadRoot(clusterResources, { uid, kind: info.kind, name: info.name, namespace: info.namespace }) : null

  return (
    <div className="flex h-full flex-col">
      <main className="flex min-h-0 w-full flex-1 flex-col gap-4 px-7 py-6">
        {!info ? <p className="text-sm text-muted-foreground">Workload not found</p> : (
          <>
            <Breadcrumbs items={[
              { label: "Workloads", href: linkTo("/topmost-owners") },
              { label: `Namespace ${info.namespace}`, href: linkTo(`/namespaces/${encodeURIComponent(info.namespace)}`) },
              { label: `${info.qualifiedKind ?? info.kind} ${info.name}`, href: linkTo(`/topmost-owners/${uid}`) },
              { label: "Logs" },
            ]} />
            <LogsTab namespace={info.namespace} workloadUid={root?.uid ?? uid} />
          </>
        )}
      </main>
    </div>
  )
}
