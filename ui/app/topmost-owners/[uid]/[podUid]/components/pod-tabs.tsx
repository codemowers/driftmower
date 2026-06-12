"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import type { ImageUsage, Issue } from "@/lib/cluster/reports"
import type { ClusterResource } from "@/lib/cluster/cluster-state"
import ImagesTab from "./images-tab"
import PortsTab from "./ports-tab"
import LogsTab from "./logs-tab"
import MetadataTab from "./metadata-tab"

const TABS = ["Images", "Ports", "Logs", "Metadata"] as const
type Tab = typeof TABS[number]

type Props = {
  pod: ClusterResource
  usages: ImageUsage[]
  issues: Issue[]
  workloadUid: string
  reportId: string | null
}

export default function PodTabs({ pod, usages, issues, workloadUid, reportId }: Props) {
  const [active, setActive] = useState<Tab>("Images")

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
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {active === "Images" && <ImagesTab usages={usages} issues={issues} workloadUid={workloadUid} reportId={reportId} />}
      {active === "Ports" && <PortsTab pod={pod} />}
      {active === "Logs" && <LogsTab />}
      {active === "Metadata" && <MetadataTab pod={pod} />}
    </div>
  )
}
