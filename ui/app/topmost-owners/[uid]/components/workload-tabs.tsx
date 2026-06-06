"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import type { ImageUsage, Issue } from "@/lib/cluster/reports"
import type { ClusterResource } from "@/lib/cluster/cluster-state"
import ContainersTab from "./containers-tab"
import PodsTab from "./pods-tab"
import DescendantsTab from "./descendants-tab"
import MetadataTab from "./metadata-tab"

const TABS = ["Containers", "Pods", "Descendants", "Metadata"] as const
type Tab = typeof TABS[number]

type Props = {
  usages: ImageUsage[]
  issues: Issue[]
  clusterResources: ClusterResource[] | null
  reportWorkloadUid: string
  liveWorkloadUid: string
  reportId: string | null
}

export default function WorkloadTabs({ usages, issues, clusterResources, reportWorkloadUid, liveWorkloadUid, reportId }: Props) {
  const [active, setActive] = useState<Tab>("Containers")

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

      {active === "Containers" && (
        <ContainersTab usages={usages} issues={issues} workloadUid={reportWorkloadUid} reportId={reportId} />
      )}
      {active === "Pods" && (
        <PodsTab clusterResources={clusterResources} reportWorkloadUid={reportWorkloadUid} liveWorkloadUid={liveWorkloadUid} reportId={reportId} />
      )}
      {active === "Descendants" && (
        <DescendantsTab clusterResources={clusterResources} reportWorkloadUid={reportWorkloadUid} liveWorkloadUid={liveWorkloadUid} reportId={reportId} />
      )}
      {active === "Metadata" && (
        <MetadataTab clusterResources={clusterResources} liveWorkloadUid={liveWorkloadUid} />
      )}
    </div>
  )
}
