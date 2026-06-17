"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { Activity, ArrowRight } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import { useNetstatd, recentCounts, filterListening, groupListening } from "@/lib/cluster/netstatd"

type Props = {
  href?: string
  podIPs?: string[]
}

const RECENT_WINDOW_MS = 15_000

const STATUS_DOT: Record<string, string> = {
  idle:       "bg-gray-400",
  connecting: "bg-status-patch animate-pulse",
  open:       "bg-status-ok",
  closed:     "bg-gray-400",
  error:      "bg-status-major",
}

const STATUS_LABEL: Record<string, string> = {
  idle:       "Idle",
  connecting: "Connecting",
  open:       "Connected",
  closed:     "Disconnected",
  error:      "Error",
}

function SectionLabel() {
  return (
    <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      Network
    </p>
  )
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("size-2 rounded-full", STATUS_DOT[status] ?? "bg-gray-400")} />
      <span className="text-xs font-medium text-foreground">{STATUS_LABEL[status] ?? status}</span>
    </span>
  )
}

function ActivityLine({ active, listening }: { active: number; listening: number }) {
  return (
    <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
      {active} active
      <span className="mx-1.5 text-muted-foreground">·</span>
      {listening} listening
    </span>
  )
}

export default function NetworkCard({ href, podIPs }: Props) {
  const status = useNetstatd(s => s.status)
  const aggregates = useNetstatd(s => s.aggregates)
  const listening = useNetstatd(s => s.listening)

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(id)
  }, [])

  const podIPSet = useMemo(() => (podIPs ? new Set(podIPs) : undefined), [podIPs])

  const { inbound, outbound } = recentCounts(aggregates, now, RECENT_WINDOW_MS, podIPSet)
  const listeningPorts = podIPSet ? filterListening(listening, podIPSet) : [...listening.values()]
  const listeningCount = groupListening(listeningPorts).length

  const inner = (
    <>
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-bg text-brand-icon">
        <Activity className="size-6" strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">Network topology</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
          <StatusBadge status={status} />
          {status === "open" && (
            <ActivityLine active={inbound + outbound} listening={listeningCount} />
          )}
        </div>
      </div>
      {href && (
        <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-brand-text" />
      )}
    </>
  )

  return (
    <div>
      <SectionLabel />
      {href ? (
        <Link
          href={href}
          className="group flex items-center gap-4 rounded-xl border border-gray-200 bg-white px-5 py-4 transition-colors hover:border-brand/40 hover:bg-brand-bg/30"
        >
          {inner}
        </Link>
      ) : (
        <div className="flex items-center gap-4 rounded-xl border border-gray-200 bg-white px-5 py-4">
          {inner}
        </div>
      )}
    </div>
  )
}
