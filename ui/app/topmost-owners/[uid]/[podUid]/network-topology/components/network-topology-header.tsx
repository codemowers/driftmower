"use client"

import { useEffect, useMemo, useState } from "react"
import { ExternalLink } from "lucide-react"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { findWorkloadRoot } from "@/lib/cluster/workload-root"
import { workloadKindLabel } from "@/lib/cluster/reports"
import {
  useNetstatd,
  type NetstatdStatus,
  aggregate,
  fetchNetstatdUrl,
  filterListening,
  groupListening,
} from "@/lib/cluster/netstatd"
import { cn } from "@/lib/utils"
import Breadcrumbs from "@/app/components/breadcrumbs"
import LiveAge from "@/app/topmost-owners/[uid]/network-topology/components/live-age"

type Props = {
  reportId: string | null
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
  reportId,
  workloadUid,
  workloadName,
  workloadKind,
  podUid,
  podName,
  namespace,
  nodeName,
  podIPs,
}: Props) {
  const clusterResources = useClusterState(s => s.clusterResources)
  const status = useNetstatd(s => s.status)
  const error = useNetstatd(s => s.error)
  const lastFlushedAt = useNetstatd(s => s.lastFlushedAt)
  const hiddenCount = useNetstatd(s => s.hiddenCount)
  const aggregates = useNetstatd(s => s.aggregates)
  const listening = useNetstatd(s => s.listening)
  const hosts = useNetstatd(s => s.hosts)

  const podIPSet = useMemo(() => new Set(podIPs), [podIPs])

  const aggregated = useMemo(
    () => aggregate(aggregates, clusterResources, hosts, podIPSet),
    [aggregates, clusterResources, hosts, podIPSet],
  )
  const listeningGroups = useMemo(
    () => groupListening(filterListening(listening, podIPSet)),
    [listening, podIPSet],
  )

  const peerTotal = aggregated.inClusterOut.length
  const inboundCount = aggregated.inbound.length
  const externalTotal = aggregated.external.length
  const portTotal = listeningGroups.length

  const apiGroup = findWorkloadRoot(clusterResources, {
    uid: workloadUid,
    kind: workloadKind,
    name: workloadName,
    namespace,
  })?.apiGroup

  const ownersHref = reportId ? `/topmost-owners?report=${reportId}` : "/topmost-owners"
  const ownerHref = reportId ? `/topmost-owners/${workloadUid}?report=${reportId}` : `/topmost-owners/${workloadUid}`
  const podDetailHref = reportId
    ? `/topmost-owners/${workloadUid}/${podUid}?report=${reportId}`
    : `/topmost-owners/${workloadUid}/${podUid}`

  return (
    <header className="flex flex-col gap-3 border-b border-gray-200 pb-5">
      <Breadcrumbs
        items={[
          { label: "Workloads", href: ownersHref },
          { label: `Namespace ${namespace}` },
          { label: `${workloadKindLabel(workloadKind, apiGroup)} ${workloadName}`, href: ownerHref },
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
