"use client"

import { useEffect, useRef } from "react"
import { cn } from "@/lib/utils/cn"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { useTabParam } from "@/lib/hooks/use-tab-param"
import type { ImageUsage, Issue } from "@/lib/cluster/reports"
import type { ClusterResource } from "@/lib/cluster/cluster-state"
import ImagesTab from "./images-tab"
import PortsTab from "./ports-tab"
import LogsTab from "./logs-tab"
import MetadataTab from "./metadata-tab"

const TABS = ["Images", "Ports", "Logs", "Metadata"] as const

function getScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null
  while (node) {
    const overflowY = getComputedStyle(node).overflowY
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      return node
    }
    node = node.parentElement
  }
  return null
}

type Props = {
  pod: ClusterResource
  usages: ImageUsage[]
  issues: Issue[]
  workloadUid: string
}

export default function PodTabs({ pod, usages, issues, workloadUid }: Props) {
  const [active, setActive] = useTabParam("ptab", TABS)
  const { suffix: contextQuery } = useContextHref()
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollOnLogsRef = useRef(false)

  useEffect(() => {
    if (active !== "Logs" || !scrollOnLogsRef.current) return
    scrollOnLogsRef.current = false

    const scroller = getScrollParent(rootRef.current)
    const content = scroller?.firstElementChild
    if (!scroller || !content) return

    const pinToBottom = () => scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" })
    pinToBottom()

    const observer = new ResizeObserver(pinToBottom)
    observer.observe(content)
    const stop = setTimeout(() => observer.disconnect(), 600)

    return () => {
      observer.disconnect()
      clearTimeout(stop)
    }
  }, [active])

  return (
    <div ref={rootRef} className="flex flex-col gap-4">
      <div className="flex border-b border-gray-200">
        {TABS.map(tab => (
          <button
            key={tab}
            type="button"
            onClick={() => {
              scrollOnLogsRef.current = tab === "Logs"
              setActive(tab)
            }}
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

      <div className="min-h-[60vh]">
        {active === "Images" && <ImagesTab usages={usages} issues={issues} workloadUid={workloadUid} contextQuery={contextQuery} />}
        {active === "Ports" && <PortsTab pod={pod} />}
        {active === "Logs" && <LogsTab ns={pod.namespace} pod={pod.name} uid={pod.uid} />}
        {active === "Metadata" && <MetadataTab pod={pod} />}
      </div>
    </div>
  )
}
