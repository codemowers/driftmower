"use client"

import { useMemo } from "react"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { findWorkloadRoot } from "@/lib/cluster/workload-root"
import {
  useNetstatd,
  findDescendantPodUids,
  aggregate,
  filterListening,
  groupListening,
  buildMatrix,
} from "@/lib/cluster/netstatd"
import Section from "./section"
import SummaryStrip from "./summary-strip"
import ListeningList from "./listening-list"
import AggregatedList from "./aggregated-list"
import ExternalList from "./external-list"
import UnknownPeersList from "./unknown-peers-list"
import PortMatrix from "./port-matrix"
import StickyHeader from "./sticky-header"
import NetworkTopologyHeader from "./network-topology-header"

type Props = {
  uid: string
  kind: string
  namespace: string
  name: string
}

export default function NetworkTopologyClient({ uid, kind, namespace, name }: Props) {
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
        <NetworkTopologyHeader
          uid={uid}
          kind={kind}
          namespace={namespace}
          name={name}
          apiGroup={apiGroup}
          status={status}
          lastFlushedAt={lastFlushedAt}
          hiddenCount={hiddenCount}
          error={error}
          peerTotal={peerTotal}
          inboundCount={inboundCount}
          externalTotal={externalTotal}
          portTotal={portTotal}
        />

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
