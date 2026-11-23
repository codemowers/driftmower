"use client"

import { useContextHref } from "@/lib/hooks/use-context-href"
import { useTabParam } from "@/lib/hooks/use-tab-param"
import type { ImageUsage } from "@/lib/cluster/reports"
import type { ClusterResource } from "@/lib/cluster/cluster-state"
import TabBar from "@/app/components/tab-bar"
import DescendantsTab from "./descendants-tab"
import MetadataTab from "./metadata-tab"
import HistoryTab from "./history-tab"
import RelatedResources from "../../components/related-resources"
import { useClusterState } from "@/lib/cluster/cluster-state"

const TABS = ["Resources", "Descendants", "Metadata", "History"] as const

type Props = {
  usages: ImageUsage[]
  clusterResources: ClusterResource[] | null
  reportWorkloadUid: string
  liveWorkloadUid: string
}

export default function WorkloadTabs({ usages, clusterResources, reportWorkloadUid, liveWorkloadUid }: Props) {
  const [active, setActive] = useTabParam("wtab", TABS)
  const { linkTo } = useContextHref()
  const workload = useClusterState(s => s.data?.workloads?.find(w => w.uid === reportWorkloadUid || w.uid === liveWorkloadUid))
  const workloadGroupKey = usages.find(u => u.workloadRootInfo?.groupKey)?.workloadRootInfo?.groupKey

  return (
    <TabBar tabs={TABS} active={active} onSelect={setActive}>
      {active === "Resources" && <RelatedResources deps={workload ?? {}} empty="This workload uses no Services, Ingresses, Certificates, ConfigMaps, Secrets or claims." />}
      {active === "Descendants" && (
        <DescendantsTab clusterResources={clusterResources} reportWorkloadUid={reportWorkloadUid} liveWorkloadUid={liveWorkloadUid} linkTo={linkTo} />
      )}
      {active === "Metadata" && (
        <MetadataTab clusterResources={clusterResources} liveWorkloadUid={liveWorkloadUid} />
      )}
      {active === "History" && workloadGroupKey && <HistoryTab workloadGroupKey={workloadGroupKey} />}
    </TabBar>
  )
}
