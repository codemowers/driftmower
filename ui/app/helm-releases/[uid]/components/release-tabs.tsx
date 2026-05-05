"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import type { ImageUsage, Issue, ReleaseInfo } from "@/lib/cluster/reports"
import type { ExplorerResource } from "@/lib/cluster/cluster-state"
import ContainersTab from "./containers-tab"
import ResourcesTab from "./resources-tab"

const TABS = ["Containers", "Resources", "Values", "Manifest"] as const
type Tab = typeof TABS[number]

type Props = {
  usages: ImageUsage[]
  issues: Issue[]
  explorerResources: ExplorerResource[] | null
  releaseInfo: ReleaseInfo
}

export default function ReleaseTabs({ usages, issues, explorerResources, releaseInfo }: Props) {
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
        <ContainersTab usages={usages} issues={issues} />
      )}
      {active === "Resources" && (
        <ResourcesTab usages={usages} explorerResources={explorerResources} releaseInfo={releaseInfo} />
      )}
      {active === "Values" && (
        <p className="text-sm text-muted-foreground">Values not available coming soon</p>
      )}
      {active === "Manifest" && (
        <p className="text-sm text-muted-foreground">Manifest not available coming soon</p>
      )}
    </div>
  )
}
