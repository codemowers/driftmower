"use client"

import { useScrollTabIntoView } from "@/lib/hooks/use-scroll-tab-into-view"
import { useTabParam } from "@/lib/hooks/use-tab-param"
import type { ClusterResource } from "@/lib/cluster/cluster-state"
import TabBar from "@/app/components/tab-bar"
import PortsTab from "./ports-tab"
import MetadataTab from "./metadata-tab"

export const POD_TABS = ["Ports", "Metadata"] as const
export const POD_TABS_ID = "pod-tabs"

type Props = {
  pod: ClusterResource
}

export default function PodTabs({ pod }: Props) {
  const [active, setActive] = useTabParam("ptab", POD_TABS)
  const { rootRef } = useScrollTabIntoView(active)

  return (
    <TabBar
      id={POD_TABS_ID}
      tabs={POD_TABS}
      active={active}
      onSelect={setActive}
      rootRef={rootRef}
    >
      {active === "Ports" && <PortsTab pod={pod} />}
      {active === "Metadata" && <MetadataTab pod={pod} />}
    </TabBar>
  )
}
