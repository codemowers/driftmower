"use client"
import { ICONS } from "@/app/components/layout/icons"
import Page from "@/app/components/layout/page"

import { useParams } from "next/navigation"
import ResourceHeader from "@/app/components/resource-header"
import { PodNav } from "@/app/components/layout/resource-navs"
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
      <Page fill>
        {clusterResources === null ? <ClusterDataPending /> : !pod ? <p className="text-sm text-muted-foreground">Pod not found</p> : (
          <>
            <ResourceHeader icon={ICONS.logs} iconAriaLabel="Pod logs" title={pod.name} copyValue={pod.name} subtitle="Logs of every container of this Pod, restarts marked"
              breadcrumbs={[
                { label: "Workloads", href: linkTo("/topmost-owners") },
                { label: `Namespace ${pod.namespace}`, href: linkTo(`/namespaces/${encodeURIComponent(pod.namespace)}`) },
                { label: "Workload", href: linkTo(`/topmost-owners/${uid}`) },
                { label: `Pod ${pod.name}`, href: linkTo(`/topmost-owners/${uid}/${podUid}`) },
                { label: "Logs" },
              ]} />
            <PodNav workloadUid={uid} podUid={podUid} namespace={pod.namespace} pod={pod.name} />
            <LogsTab namespace={pod.namespace} workloadUid={uid} pod={pod} />
          </>
        )}
      </Page>
    </div>
  )
}
