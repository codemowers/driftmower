"use client"

import { useEffect, useState } from "react"
import { ExternalLink } from "lucide-react"
import { workloadKindLabel } from "@/lib/cluster/reports"
import { type NetstatdStatus, fetchNetstatdUrl } from "@/lib/cluster/netstatd"
import { cn } from "@/lib/utils"
import Breadcrumbs from "@/app/components/breadcrumbs"
import LiveAge from "./live-age"

type Props = {
  reportId: string | null
  uid: string
  kind: string
  namespace: string
  name: string
  apiGroup?: string
  status: NetstatdStatus
  lastFlushedAt: number | null
  hiddenCount: number
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
  reportId,
  uid,
  kind,
  namespace,
  name,
  apiGroup,
  status,
  lastFlushedAt,
  hiddenCount,
  error,
  peerTotal,
  inboundCount,
  externalTotal,
  portTotal,
}: Props) {
  const ownersHref = reportId ? `/topmost-owners?report=${reportId}` : "/topmost-owners"
  const ownerHref = reportId ? `/topmost-owners/${uid}?report=${reportId}` : `/topmost-owners/${uid}`

  return (
    <header className="flex flex-col gap-3 border-b border-gray-200 pb-5">
      <Breadcrumbs
        items={[
          { label: "Workloads", href: ownersHref },
          { label: `Namespace ${namespace}` },
          { label: `${workloadKindLabel(kind, apiGroup)} ${name}`, href: ownerHref },
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
          name={name}
          peerTotal={peerTotal}
          portTotal={portTotal}
          inboundCount={inboundCount}
          externalTotal={externalTotal}
        />
        <NetstatdLink />
      </div>

      {error && (
        <p className="rounded-md border border-status-major-bg bg-status-major-bg/40 px-3 py-2 text-xs text-status-major-label">
          {error}
        </p>
      )}
    </header>
  )
}

function NetstatdLink() {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    fetchNetstatdUrl()
      .then(resolved => active && setUrl(resolved))
      .catch(() => active && setUrl(""))
    return () => {
      active = false
    }
  }, [])

  if (url === null) return null
  return (
    <div className="absolute bottom-0 right-0">
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-brand/40 hover:bg-brand-bg/30 hover:text-brand"
        >
          View on netstatd
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      ) : (
        <span className="text-xs font-medium text-muted-foreground">
          netstatd env var not set or missing ingress
        </span>
      )}
    </div>
  )
}

function SummarySentence({
  name,
  peerTotal,
  portTotal,
  inboundCount,
  externalTotal,
}: {
  name: string
  peerTotal: number
  portTotal: number
  inboundCount: number
  externalTotal: number
}) {
  if (peerTotal + portTotal + inboundCount + externalTotal === 0) return null
  return (
    <p className="text-sm leading-relaxed text-muted-foreground">
      <span className="font-mono text-foreground">{name}</span>
      {" talks to "}
      <strong className="font-mono font-semibold tabular-nums text-foreground">{peerTotal}</strong>
      {peerTotal === 1 ? " in-cluster peer, " : " in-cluster peers, "}
      {externalTotal > 0 && (
        <>
          reaches{" "}
          <strong className="font-mono font-semibold tabular-nums text-foreground">{externalTotal}</strong>
          {externalTotal === 1 ? " external endpoint, " : " external endpoints, "}
        </>
      )}
      accepts{" "}
      <strong className="font-mono font-semibold tabular-nums text-foreground">{inboundCount}</strong>
      {inboundCount === 1 ? " inbound client, " : " inbound clients, "}
      and exposes{" "}
      <strong className="font-mono font-semibold tabular-nums text-foreground">{portTotal}</strong>
      {portTotal === 1 ? " socket." : " sockets."}
    </p>
  )
}
