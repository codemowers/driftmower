"use client"

import { useContextHref } from "@/lib/hooks/use-context-href"
import { useScrollTabIntoView } from "@/lib/hooks/use-scroll-tab-into-view"
import { useTabParam } from "@/lib/hooks/use-tab-param"
import type { ImageUsage, Issue } from "@/lib/cluster/reports"
import type { ClusterResource } from "@/lib/cluster/cluster-state"
import TabBar from "@/app/components/tab-bar"
import ImagesTab from "./images-tab"
import PortsTab from "./ports-tab"
import LogsTab from "./logs-tab"
import MetadataTab from "./metadata-tab"

export const POD_TABS = ["Images", "Ports", "Logs", "Metadata"] as const
export const POD_TABS_ID = "pod-tabs"

type Props = {
  pod: ClusterResource
  usages: ImageUsage[]
  issues: Issue[]
  workloadUid: string
}

export default function PodTabs({ pod, usages, issues, workloadUid }: Props) {
  const [active, setActive] = useTabParam("ptab", POD_TABS)
  const { suffix: contextQuery } = useContextHref()
  const { rootRef, requestScroll } = useScrollTabIntoView(active)

  return (
    <TabBar
      id={POD_TABS_ID}
      tabs={POD_TABS}
      active={active}
      onSelect={tab => {
        if (tab === "Logs") requestScroll()
        setActive(tab)
      }}
      rootRef={rootRef}
    >
      {active === "Images" && <ImagesTab usages={usages} issues={issues} workloadUid={workloadUid} contextQuery={contextQuery} />}
      {active === "Ports" && <PortsTab pod={pod} />}
      {active === "Logs" && <LogsTab pod={pod} />}
      {active === "Metadata" && <MetadataTab pod={pod} />}
    </TabBar>
  )
}
