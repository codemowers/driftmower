"use client"

import Link from "next/link"
import { Activity, ExternalLink } from "lucide-react"
import { cn } from "@/lib/utils"
import { useNetstatd } from "@/lib/cluster/netstatd"

type Props = {
  href: string
  scopeLabel: string
}

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

export default function NetworkCard({ href, scopeLabel }: Props) {
  const status = useNetstatd(s => s.status)
  const rawEventCount = useNetstatd(s => s.rawEventCount)
  const connectionCount = useNetstatd(s => s.connections.size)

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Network
      </p>
      <Link
        href={href}
        className="group flex items-center gap-5 rounded-xl border border-gray-200 bg-white px-5 py-5 transition-colors hover:border-brand/40 hover:bg-brand-bg/30"
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-bg text-brand-icon">
          <Activity className="size-6" strokeWidth={2} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="font-semibold text-foreground">Network topology</p>
          </div>
          <p className="font-mono text-xs text-muted-foreground">
            live tcp/udp · netstatd
          </p>
        </div>

        <div className="hidden flex-col items-end gap-0.5 sm:flex">
          <div className="flex items-center gap-2">
            <span className={cn("size-2 rounded-full", STATUS_DOT[status] ?? "bg-gray-400")} />
            <span className="text-xs font-medium text-foreground">{STATUS_LABEL[status] ?? status}</span>
          </div>
          <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {scopeLabel} · {connectionCount.toLocaleString()} {connectionCount === 1 ? "conn" : "conns"} · {rawEventCount.toLocaleString()} events
          </p>
        </div>

        <span className="flex shrink-0 items-center gap-1.5 text-sm text-brand-label transition-colors group-hover:text-brand-text group-hover:underline">
          <ExternalLink className="size-3.5" />
          View topology →
        </span>
      </Link>
    </div>
  )
}
