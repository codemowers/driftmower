"use client"

import { cn } from "@/lib/utils/cn"
import { useTabParam } from "@/lib/hooks/use-tab-param"
import type { ImageUsage, Issue, ReleaseInfo } from "@/lib/cluster/reports"
import type { ClusterResource } from "@/lib/cluster/cluster-state"
import ContainersTab from "./containers-tab"
import ResourcesTab from "./resources-tab"

const TABS = ["Containers", "Resources", "Values", "Manifest"] as const

type Props = {
  usages: ImageUsage[]
  issues: Issue[]
  clusterResources: ClusterResource[] | null
  releaseInfo: ReleaseInfo
  reportId: string | null
}

export default function ReleaseTabs({ usages, issues, clusterResources, releaseInfo, reportId }: Props) {
  const [active, setActive] = useTabParam("htab", TABS)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex border-b border-gray-200">
        {TABS.map(tab => (
          <button
            key={tab}
            type="button"
            onClick={() => setActive(tab)}
            className={cn(
              "px-4 py-2.5 text-sm font-medium transition-colors",
              active === tab
                ? "border-b-2 border-brand text-brand-text"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="min-h-[60vh]">
        {active === "Containers" && (
          <ContainersTab usages={usages} issues={issues} reportId={reportId} />
        )}
        {active === "Resources" && (
          <ResourcesTab usages={usages} clusterResources={clusterResources} releaseInfo={releaseInfo} reportId={reportId} />
        )}
        {active === "Values" && (
          <p className="text-sm text-muted-foreground">Values not available coming soon</p>
        )}
        {active === "Manifest" && (
          <p className="text-sm text-muted-foreground">Manifest not available coming soon</p>
        )}
      </div>
    </div>
  )
}
