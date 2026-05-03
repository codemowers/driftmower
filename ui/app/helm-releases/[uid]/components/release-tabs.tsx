"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import type { ImageUsage, Issue } from "@/lib/cluster/reports"
import ContainersTab from "./containers-tab"

const TABS = ["Containers", "Resources", "Values", "Manifest"] as const
type Tab = typeof TABS[number]

type Props = {
  usages: ImageUsage[]
  issues: Issue[]
}

export default function ReleaseTabs({ usages, issues }: Props) {
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
        <p className="text-sm text-muted-foreground">Resources coming soon</p>
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
