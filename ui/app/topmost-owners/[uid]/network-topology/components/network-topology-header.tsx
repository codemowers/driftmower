"use client"

import NetworkSummary from "@/app/components/network-summary"
import { useNetstatdMissing, type NetstatdStatus, type UpstreamHealth } from "@/lib/features/netstatd"
import { cn } from "@/lib/utils/cn"
import { useContextHref } from "@/lib/hooks/use-context-href"
import Breadcrumbs from "@/app/components/breadcrumbs"
import { NetstatdMissingStatus } from "@/app/components/netstatd-missing"
import LiveAge from "./live-age"

type Props = {
  uid: string
  kind: string
  kindLabel: string
  namespace: string
  name: string
  status: NetstatdStatus
  lastFlushedAt: number | null
  hiddenCount: number
  upstream: UpstreamHealth | null
  error: string | null
  peerTotal: number
  inboundCount: number
  externalTotal: number
  portTotal: number
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
  open:       "Connected",
  closed:     "Disconnected",
  error:      "Error",
}

export default function NetworkTopologyHeader({
  uid,
  kind,
  kindLabel,
  namespace,
  name,
  status,
  lastFlushedAt,
  hiddenCount,
  upstream,
  error,
  peerTotal,
  inboundCount,
  externalTotal,
  portTotal,
}: Props) {
  const { linkTo } = useContextHref()
  const missing = useNetstatdMissing()
  const ownersHref = linkTo("/topmost-owners")
  const ownerHref = linkTo(`/topmost-owners/${uid}`)

  return (
    <header className="flex flex-col gap-3 border-b border-gray-200 pb-5">
      <Breadcrumbs
        items={[
          { label: "Workloads", href: ownersHref },
          { label: `Namespace ${namespace}` },
          { label: `${kindLabel} ${name}`, href: ownerHref },
          { label: "Network topology" },
        ]}
      />

      <div className="flex items-start justify-between gap-8">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground">
            Network topology
          </h1>
          <p className="font-mono text-sm text-muted-foreground">
            <span className="text-foreground">{kind}</span>
            <span className="mx-2 text-muted-foreground/50">·</span>
            <span>{namespace}</span>
            <span className="mx-2 text-muted-foreground/50">·</span>
            <span>{name}</span>
          </p>
        </div>
        {missing ? (
          <NetstatdMissingStatus />
        ) : (
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
              <span className={cn("size-2.5 shrink-0 rounded-full", STATUS_DOT[status])} />
              <span className="text-sm font-medium text-foreground">{STATUS_LABEL[status]}</span>
              {status === "open" && (
                <LiveAge
                  timestamp={lastFlushedAt}
                  prefix="· "
                  className="font-mono text-[11px] tabular-nums text-muted-foreground"
                />
              )}
            </div>
            <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
              live · netstatd · /conntrack
              {upstream && ` · ${upstream.connected}/${upstream.total} nodes`}
            </p>
            {hiddenCount > 0 && (
              <p className="font-mono text-[10px] tracking-wider text-muted-foreground/70 tabular-nums">
                {hiddenCount.toLocaleString()} more not shown
              </p>
            )}
          </div>
        )}
      </div>

      <div className="relative min-h-6">
        <NetworkSummary
          name={name}
          peerTotal={peerTotal}
          portTotal={portTotal}
          inboundCount={inboundCount}
          externalTotal={externalTotal}
        />
      </div>

      {error && (
        <p className="rounded-md border border-status-major-bg bg-status-major-bg/40 px-3 py-2 text-xs text-status-major-label">
          {error}
        </p>
      )}
    </header>
  )
}
