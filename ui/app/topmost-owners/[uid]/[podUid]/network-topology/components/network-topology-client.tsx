"use client"

import { useMemo } from "react"
import { useClusterState } from "@/lib/cluster/cluster-state"
import {
  useNetstatd,
  type NetstatdStatus,
  aggregate,
  filterListening,
  groupListening,
} from "@/lib/cluster/netstatd"
import { cn } from "@/lib/utils"
import Breadcrumbs from "@/app/components/breadcrumbs"
import Section from "@/app/topmost-owners/[uid]/network-topology/components/section"
import SummaryStrip from "@/app/topmost-owners/[uid]/network-topology/components/summary-strip"
import ListeningList from "@/app/topmost-owners/[uid]/network-topology/components/listening-list"
import AggregatedList from "@/app/topmost-owners/[uid]/network-topology/components/aggregated-list"
import ExternalList from "@/app/topmost-owners/[uid]/network-topology/components/external-list"
import UnknownPeersList from "@/app/topmost-owners/[uid]/network-topology/components/unknown-peers-list"
import LiveAge from "@/app/topmost-owners/[uid]/network-topology/components/live-age"
import StickyHeader from "@/app/topmost-owners/[uid]/network-topology/components/sticky-header"

type Props = {
  reportId: string | null
  workloadUid: string
  workloadName: string
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

export default function NetworkTopologyClient({
  reportId,
  workloadUid,
  workloadName,
  podUid,
  podName,
  namespace,
  nodeName,
  podIPs,
}: Props) {
  const explorerResources = useClusterState(s => s.explorerResources)
  const status = useNetstatd(s => s.status)
  const error = useNetstatd(s => s.error)
  const lastFlushedAt = useNetstatd(s => s.lastFlushedAt)
  const aggregates = useNetstatd(s => s.aggregates)
  const listening = useNetstatd(s => s.listening)
  const hosts = useNetstatd(s => s.hosts)

  const podIPSet = useMemo(() => new Set(podIPs), [podIPs])

  const aggregated = useMemo(
    () => aggregate(aggregates, explorerResources, hosts, podIPSet),
    [aggregates, explorerResources, hosts, podIPSet],
  )

  const ourListening = useMemo(
    () => filterListening(listening, podIPSet),
    [listening, podIPSet],
  )

  const listeningGroups = useMemo(() => groupListening(ourListening), [ourListening])

  const ownersHref = reportId ? `/topmost-owners?report=${reportId}` : "/topmost-owners"
  const ownerHref = reportId ? `/topmost-owners/${workloadUid}?report=${reportId}` : `/topmost-owners/${workloadUid}`
  const podDetailHref = reportId
    ? `/topmost-owners/${workloadUid}/${podUid}?report=${reportId}`
    : `/topmost-owners/${workloadUid}/${podUid}`

  const portTotal = listeningGroups.length
  const inboundCount = aggregated.inbound.length
  const peerTotal = aggregated.inClusterOut.length
  const externalTotal = aggregated.external.length
  const unknownTotal = aggregated.unknownOut.length

  return (
    <>
      <StickyHeader
        kind="Pod"
        namespace={namespace}
        name={podName}
        status={status}
        lastFlushedAt={lastFlushedAt}
      />

      <div className="flex flex-col gap-6">
      <Breadcrumbs
        items={[
          { label: "Topmost Owners", href: ownersHref },
          { label: workloadName, href: ownerHref },
          { label: podName, href: podDetailHref },
          { label: "Network topology" },
        ]}
      />

      <header className="flex flex-col gap-3 border-b border-gray-200 pb-6">
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
          </div>
        </div>

        <SummarySentence
          name={podName}
          peerTotal={peerTotal}
          portTotal={portTotal}
          inboundCount={inboundCount}
          externalTotal={externalTotal}
        />

        {error && (
          <p className="rounded-md border border-status-major-bg bg-status-major-bg/40 px-3 py-2 text-xs text-status-major-label">
            {error}
          </p>
        )}
      </header>

      <SummaryStrip
        listeningCount={portTotal}
        inboundClientCount={inboundCount}
        outboundInClusterCount={peerTotal}
        externalCount={externalTotal}
      />

      <Section
        title="Listening"
        count={listeningGroups.length}
        emptyText="No listening ports detected for this pod."
        height="h-64"
      >
        <ListeningList groups={listeningGroups} />
      </Section>

      <Section
        title="Inbound · clients"
        count={inboundCount}
        emptyText="No inbound clients seen yet."
        height="h-64"
      >
        <AggregatedList rows={aggregated.inbound} />
      </Section>

      <Section
        title="Outbound · in-cluster"
        count={peerTotal}
        emptyText="No in-cluster outbound traffic seen yet."
        height="h-80"
      >
        <AggregatedList rows={aggregated.inClusterOut} />
      </Section>

      <Section
        title="Outbound · unknown peers"
        count={unknownTotal}
        emptyText="No private-range peers without a resolvable owner."
        height="h-64"
      >
        <UnknownPeersList rows={aggregated.unknownOut} />
      </Section>

      <Section
        title="Outbound · external"
        count={externalTotal}
        emptyText="No external traffic seen yet."
        height="h-80"
      >
        <ExternalList rows={aggregated.external} />
      </Section>
      </div>
    </>
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
      {" listens on "}
      <strong className="font-mono font-semibold tabular-nums text-foreground">{portTotal}</strong>
      {portTotal === 1 ? " socket, " : " sockets, "}
      {"talks to "}
      <strong className="font-mono font-semibold tabular-nums text-foreground">{peerTotal}</strong>
      {peerTotal === 1 ? " in-cluster peer, " : " in-cluster peers, "}
      {externalTotal > 0 && (
        <>
          reaches{" "}
          <strong className="font-mono font-semibold tabular-nums text-foreground">{externalTotal}</strong>
          {externalTotal === 1 ? " external endpoint, " : " external endpoints, "}
        </>
      )}
      {"and accepts "}
      <strong className="font-mono font-semibold tabular-nums text-foreground">{inboundCount}</strong>
      {inboundCount === 1 ? " inbound client." : " inbound clients."}
    </p>
  )
}
