"use client"

import { useTabParam } from "@/lib/hooks/use-tab-param"
import type { ImageUsage, Issue } from "@/lib/cluster/reports"
import type { ClusterResource } from "@/lib/cluster/cluster-state"
import TabBar from "@/app/components/tab-bar"
import ContainersTab from "./containers-tab"
import ResourcesTab from "./resources-tab"

const TABS = ["Containers", "Resources", "Values", "Manifest"] as const

type Props = {
  usages: ImageUsage[]
  issues: Issue[]
  clusterResources: ClusterResource[] | null
  reportId: string | null
}

export default function ReleaseTabs({ usages, issues, clusterResources, reportId }: Props) {
  const [active, setActive] = useTabParam("htab", TABS)

  return (
    <TabBar tabs={TABS} active={active} onSelect={setActive}>
      {active === "Containers" && (
        <ContainersTab usages={usages} issues={issues} reportId={reportId} />
      )}
      {active === "Resources" && (
        <ResourcesTab usages={usages} clusterResources={clusterResources} reportId={reportId} />
      )}
      {active === "Values" && (
        <p className="text-sm text-muted-foreground">Values not available coming soon</p>
      )}
      {active === "Manifest" && (
        <p className="text-sm text-muted-foreground">Manifest not available coming soon</p>
      )}
    </TabBar>
  )
}
