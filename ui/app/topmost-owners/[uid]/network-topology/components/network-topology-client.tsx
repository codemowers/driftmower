"use client"

import { useMemo } from "react"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { findWorkloadRoot } from "@/lib/cluster/workload-root"
import { workloadKindLabel } from "@/lib/cluster/reports"
import {
  useNetstatd,
  type NetstatdStatus,
  findDescendantPodUids,
  aggregate,
  filterListening,
  groupListening,
  buildMatrix,
} from "@/lib/cluster/netstatd"
import { cn } from "@/lib/utils"
import Breadcrumbs from "@/app/components/breadcrumbs"
import Section from "./section"
import SummaryStrip from "./summary-strip"
import ListeningList from "./listening-list"
import AggregatedList from "./aggregated-list"
import ExternalList from "./external-list"
import UnknownPeersList from "./unknown-peers-list"
import PortMatrix from "./port-matrix"
import LiveAge from "./live-age"
import StickyHeader from "./sticky-header"

type Props = {
  uid: string
  reportId: string | null
  kind: string
  namespace: string
  name: string
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

export default function NetworkTopologyClient({ uid, reportId, kind, namespace, name }: Props) {
  const clusterResources = useClusterState(s => s.clusterResources)
  const status = useNetstatd(s => s.status)
  const error = useNetstatd(s => s.error)
  const lastFlushedAt = useNetstatd(s => s.lastFlushedAt)
  const aggregates = useNetstatd(s => s.aggregates)
  const listening = useNetstatd(s => s.listening)
  const hosts = useNetstatd(s => s.hosts)
  const hiddenCount = useNetstatd(s => s.hiddenCount)

  const scope = useMemo(
    () => findDescendantPodUids(clusterResources, uid),
    [clusterResources, uid],
  )

  const aggregated = useMemo(
    () => aggregate(aggregates, clusterResources, hosts),
    [aggregates, clusterResources, hosts],
  )

  const ourListening = useMemo(
    () => filterListening(listening, scope.podIPs),
    [listening, scope.podIPs],
  )

  const listeningGroups = useMemo(() => groupListening(ourListening), [ourListening])

  const matrix = useMemo(
    () => buildMatrix(aggregated.inClusterOut, aggregated.unknownOut, aggregated.external),
    [aggregated.inClusterOut, aggregated.unknownOut, aggregated.external],
  )

  const ownersHref = reportId ? `/topmost-owners?report=${reportId}` : "/topmost-owners"
  const ownerHref = reportId ? `/topmost-owners/${uid}?report=${reportId}` : `/topmost-owners/${uid}`
  const apiGroup = findWorkloadRoot(clusterResources, { uid, kind, name, namespace })?.apiGroup

  const portTotal = listeningGroups.length
  const inboundCount = aggregated.inbound.length
  const peerTotal = aggregated.inClusterOut.length
  const externalTotal = aggregated.external.length
  const unknownTotal = aggregated.unknownOut.length

  return (
    <>
      <StickyHeader
        kind={kind}
        namespace={namespace}
        name={name}
        status={status}
        lastFlushedAt={lastFlushedAt}
      />

      <div className="flex flex-col gap-6">
      <Breadcrumbs
        items={[
          { label: "Workloads", href: ownersHref },
          { label: `Namespace ${namespace}` },
          { label: `${workloadKindLabel(kind, apiGroup)} ${name}`, href: ownerHref },
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

        <SummarySentence
          name={name}
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
        podCount={scope.podUids.size}
        listeningCount={portTotal}
        inboundClientCount={inboundCount}
        outboundInClusterCount={peerTotal}
        externalCount={externalTotal}
      />

      <Section
        title="Listening"
        count={listeningGroups.length}
        emptyText="No listening ports detected for this workload."
        height="h-80"
      >
        <ListeningList groups={listeningGroups} />
      </Section>

      <Section
        title="Inbound · clients"
        count={inboundCount}
        emptyText="No inbound clients seen yet."
        height="h-80"
      >
        <AggregatedList rows={aggregated.inbound} />
      </Section>

      <Section
        title="Outbound · in-cluster"
        count={peerTotal}
        emptyText="No in-cluster outbound traffic seen yet."
        height="h-[36rem]"
      >
        <AggregatedList rows={aggregated.inClusterOut} />
      </Section>

      <Section
        title="Outbound · unknown peers"
        count={unknownTotal}
        emptyText="No private-range peers without a resolvable owner."
        height="h-72"
      >
        <UnknownPeersList rows={aggregated.unknownOut} />
      </Section>

      <Section
        title="Outbound · external"
        count={externalTotal}
        emptyText="No external traffic seen yet."
        height="h-[26rem]"
      >
        <ExternalList rows={aggregated.external} />
      </Section>

      <section className="flex h-[44rem] flex-col overflow-hidden rounded-xl border border-gray-200 bg-white">
        <header className="flex shrink-0 items-center justify-between border-b border-gray-200 bg-gray-50 px-4 py-2.5">
          <p className="text-xs font-medium tracking-wide text-muted-foreground">
            <span className="uppercase">Port / protocol matrix</span>
            <span className="mx-2 text-muted-foreground/50">·</span>
            <span className="font-mono tabular-nums text-foreground">
              {matrix.rows.length} × {matrix.columns.length}
            </span>
          </p>
        </header>
        <div className="flex-1 overflow-hidden">
          <PortMatrix matrix={matrix} />
        </div>
      </section>
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
