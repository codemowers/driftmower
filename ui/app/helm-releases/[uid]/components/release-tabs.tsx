"use client"

import { useScrollTabIntoView } from "@/lib/hooks/use-scroll-tab-into-view"
import { useTabParam } from "@/lib/hooks/use-tab-param"
import type { ImageUsage, Issue, ReleaseInfo } from "@/lib/cluster/reports"
import type { ClusterResource } from "@/lib/cluster/cluster-state"
import TabBar from "@/app/components/tab-bar"
import ContainersTab from "./containers-tab"
import ResourcesTab from "./resources-tab"
import ValuesTab from "./values-tab"
import ManifestTab from "./manifest-tab"

const TABS = ["Containers", "Resources", "Values", "Manifest"] as const
const SCROLL_INTO_VIEW_TABS = new Set<string>(["Values", "Manifest"])

type Props = {
  releaseInfo: ReleaseInfo
  usages: ImageUsage[]
  issues: Issue[]
  clusterResources: ClusterResource[] | null
  reportId: string | null
}

export default function ReleaseTabs({ releaseInfo, usages, issues, clusterResources, reportId }: Props) {
  const [active, setActive] = useTabParam("htab", TABS)
  const { rootRef, requestScroll } = useScrollTabIntoView(active)

  return (
    <TabBar
      tabs={TABS}
      active={active}
      onSelect={tab => {
        if (SCROLL_INTO_VIEW_TABS.has(tab)) requestScroll()
        setActive(tab)
      }}
      rootRef={rootRef}
    >
      {active === "Containers" && (
        <ContainersTab usages={usages} issues={issues} reportId={reportId} />
      )}
      {active === "Resources" && (
        <ResourcesTab usages={usages} clusterResources={clusterResources} reportId={reportId} />
      )}
      {active === "Values" && <ValuesTab releaseInfo={releaseInfo} />}
      {active === "Manifest" && <ManifestTab releaseInfo={releaseInfo} />}
    </TabBar>
  )
}
