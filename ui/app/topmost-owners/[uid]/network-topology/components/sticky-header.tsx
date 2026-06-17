"use client"

import { useEffect, useState } from "react"
import { cn } from "@/lib/utils/cn"
import type { NetstatdStatus } from "@/lib/cluster/netstatd"
import LiveAge from "./live-age"

type Props = {
  kind: string
  namespace: string
  name: string
  status: NetstatdStatus
  lastFlushedAt: number | null
}

const STATUS_DOT: Record<NetstatdStatus, string> = {
  idle:       "bg-gray-400",
  connecting: "bg-status-patch animate-pulse",
  open:       "bg-status-ok",
  closed:     "bg-gray-400",
  error:      "bg-status-major",
}

const STATUS_LABEL: Record<NetstatdStatus, string> = {
  idle:       "Idle",
  connecting: "Connecting",
  open:       "Live",
  closed:     "Disconnected",
  error:      "Error",
}

export default function StickyHeader({ kind, namespace, name, status, lastFlushedAt }: Props) {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    function onScroll(this: HTMLElement) {
      setScrolled(this.scrollTop > 60)
    }
    const main = document.querySelector("main")
    const scroller = main?.parentElement ?? document.documentElement
    scroller.addEventListener("scroll", onScroll as EventListener, { passive: true })
    return () => scroller.removeEventListener("scroll", onScroll as EventListener)
  }, [])

  return (
    <div
      className={cn(
        "sticky top-0 z-30 -mx-7 border-b border-transparent bg-white/95 px-7 backdrop-blur transition-all",
        scrolled ? "border-gray-200 py-3" : "py-0 -mb-6",
      )}
    >
      <div className={cn("flex items-center justify-between gap-6", scrolled ? "h-auto" : "h-0 opacity-0 overflow-hidden")}>
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="truncate font-heading text-base font-semibold text-foreground">
            {name}
          </span>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {kind} · {namespace} · Network topology
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={cn("size-2 rounded-full", STATUS_DOT[status])} />
          <span className="text-xs font-medium text-foreground">{STATUS_LABEL[status]}</span>
          {status === "open" && (
            <LiveAge
              timestamp={lastFlushedAt}
              prefix="· "
              className="font-mono text-[11px] tabular-nums text-muted-foreground"
            />
          )}
        </div>
      </div>
    </div>
  )
}
