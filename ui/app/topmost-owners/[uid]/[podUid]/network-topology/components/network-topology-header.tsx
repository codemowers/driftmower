"use client"

import { useMemo } from "react"
import {
  useNetstatd,
  type NetstatdStatus,
  aggregate,
  filterListening,
  groupListening,
} from "@/lib/features/netstatd"
import { cn } from "@/lib/utils/cn"
import { useContextHref } from "@/lib/hooks/use-context-href"
import Breadcrumbs from "@/app/components/breadcrumbs"
import LiveAge from "@/app/topmost-owners/[uid]/network-topology/components/live-age"

type Props = {
  workloadUid: string
  workloadName: string
  workloadKind: string
  podUid: string
  podName: string
  namespace: string
  nodeName: string | null
  podIPs: string[]
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
  workloadUid,
  workloadName,
  workloadKind,
  podUid,
  podName,
  namespace,
  nodeName,
  podIPs,
}: Props) {
  const status = useNetstatd(s => s.status)
  const error = useNetstatd(s => s.error)
  const lastFlushedAt = useNetstatd(s => s.lastFlushedAt)
  const hiddenCount = useNetstatd(s => s.hiddenCount)
  const upstream = useNetstatd(s => s.upstream)
  const aggregates = useNetstatd(s => s.aggregates)
  const listening = useNetstatd(s => s.listening)

  const podIPSet = useMemo(() => new Set(podIPs), [podIPs])
  const podUidSet = useMemo(() => new Set([podUid]), [podUid])

  const aggregated = useMemo(() => aggregate(aggregates, podIPSet), [aggregates, podIPSet])
  const listeningGroups = useMemo(
    () => groupListening(filterListening(listening, podUidSet)),
    [listening, podUidSet],
  )

  const peerTotal = aggregated.inClusterOut.length
  const inboundCount = aggregated.inbound.length
  const externalTotal = aggregated.external.length
  const portTotal = listeningGroups.length

  const { linkTo } = useContextHref()
  const ownersHref = linkTo("/topmost-owners")
  const ownerHref = linkTo(`/topmost-owners/${workloadUid}`)
  const podDetailHref = linkTo(`/topmost-owners/${workloadUid}/${podUid}`)

  return (
    <header className="flex flex-col gap-3 border-b border-gray-200 pb-5">
      <Breadcrumbs
        items={[
          { label: "Workloads", href: ownersHref },
          { label: `Namespace ${namespace}` },
          { label: `${workloadKind} ${workloadName}`, href: ownerHref },
          { label: `Pod ${podName}`, href: podDetailHref },
          { label: "Network topology" },
        ]}
      />

      <div className="flex items-start justify-between gap-8">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground">
            Network topology
          </h1>
          <p className="font-mono text-sm text-muted-foreground">
            <span className="text-foreground">{podName}</span>
          </p>
          <p className="font-mono text-xs text-muted-foreground">
            {podIPs.length > 0 ? podIPs.join(", ") : "no pod IP"}
            <span className="mx-2 text-muted-foreground/50">·</span>
            <span>{nodeName ?? "—"}</span>
            <span className="mx-2 text-muted-foreground/50">·</span>
            <span>{namespace}</span>
          </p>
        </div>
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
      </div>

      <div className="relative min-h-6">
        <SummarySentence
          name={podName}
          peerTotal={peerTotal}
          inboundCount={inboundCount}
          externalTotal={externalTotal}
          portTotal={portTotal}
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

function SummarySentence({
  name,
  peerTotal,
  inboundCount,
  externalTotal,
  portTotal,
}: {
  name: string
  peerTotal: number
  inboundCount: number
  externalTotal: number
  portTotal: number
}) {
  if (peerTotal + inboundCount + externalTotal + portTotal === 0) return null
  return (
    <p className="text-sm leading-relaxed text-muted-foreground">
      <span className="font-mono text-foreground">{name}</span>
      {" talks to "}
      <strong className="font-mono font-semibold tabular-nums text-foreground">{peerTotal}</strong>
      {peerTotal === 1 ? " in-cluster peer, " : " in-cluster peers, "}
      {"accepts "}
      <strong className="font-mono font-semibold tabular-nums text-foreground">{inboundCount}</strong>
      {inboundCount === 1 ? " inbound client, " : " inbound clients, "}
      {externalTotal > 0 && (
        <>
          {"reaches "}
          <strong className="font-mono font-semibold tabular-nums text-foreground">{externalTotal}</strong>
          {externalTotal === 1 ? " external endpoint, " : " external endpoints, "}
        </>
      )}
      {"and exposes "}
      <strong className="font-mono font-semibold tabular-nums text-foreground">{portTotal}</strong>
      {portTotal === 1 ? " socket." : " sockets."}
    </p>
  )
}
