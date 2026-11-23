"use client"
import { ICONS } from "@/app/components/layout/icons"
import Page from "@/app/components/layout/page"

import { useParams } from "next/navigation"
import ResourceHeader from "@/app/components/resource-header"
import { WorkloadNav } from "@/app/components/layout/resource-navs"
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
      <Page fill>
        {!info ? <p className="text-sm text-muted-foreground">Workload not found</p> : (
          <>
            <ResourceHeader icon={ICONS.logs} iconAriaLabel="Workload logs" title={info.name} copyValue={info.name} subtitle="Logs of every Pod of this workload"
              breadcrumbs={[
                { label: "Workloads", href: linkTo("/topmost-owners") },
                { label: `Namespace ${info.namespace}`, href: linkTo(`/namespaces/${encodeURIComponent(info.namespace)}`) },
                { label: `${info.qualifiedKind ?? info.kind} ${info.name}`, href: linkTo(`/topmost-owners/${uid}`) },
                { label: "Logs" },
              ]} />
            <WorkloadNav uid={uid} namespace={info.namespace} />
            <LogsTab namespace={info.namespace} workloadUid={root?.uid ?? uid} />
          </>
        )}
      </Page>
    </div>
  )
}
