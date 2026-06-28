"use client"

import { useContextHref } from "@/lib/hooks/use-context-href"
import { useTabParam } from "@/lib/hooks/use-tab-param"
import type { ImageUsage, Issue } from "@/lib/cluster/reports"
import type { ClusterResource } from "@/lib/cluster/cluster-state"
import TabBar from "@/app/components/core/tab-bar"
import ImagesTab from "./images-tab"
import PodsTab from "./pods-tab"
import DescendantsTab from "./descendants-tab"
import MetadataTab from "./metadata-tab"

const TABS = ["Images", "Pods", "Descendants", "Metadata"] as const

type Props = {
  usages: ImageUsage[]
  issues: Issue[]
  clusterResources: ClusterResource[] | null
  reportWorkloadUid: string
  liveWorkloadUid: string
}

export default function WorkloadTabs({ usages, issues, clusterResources, reportWorkloadUid, liveWorkloadUid }: Props) {
  const [active, setActive] = useTabParam("wtab", TABS)
  const { suffix: contextQuery } = useContextHref()

  return (
    <TabBar tabs={TABS} active={active} onSelect={setActive}>
      {active === "Images" && (
        <ImagesTab usages={usages} issues={issues} workloadUid={reportWorkloadUid} contextQuery={contextQuery} />
      )}
      {active === "Pods" && (
        <PodsTab clusterResources={clusterResources} reportWorkloadUid={reportWorkloadUid} liveWorkloadUid={liveWorkloadUid} contextQuery={contextQuery} />
      )}
      {active === "Descendants" && (
        <DescendantsTab clusterResources={clusterResources} reportWorkloadUid={reportWorkloadUid} liveWorkloadUid={liveWorkloadUid} contextQuery={contextQuery} />
      )}
      {active === "Metadata" && (
        <MetadataTab clusterResources={clusterResources} liveWorkloadUid={liveWorkloadUid} />
      )}
    </TabBar>
  )
}
