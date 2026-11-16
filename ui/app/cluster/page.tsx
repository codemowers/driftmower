"use client"

import { useEffect, useState, type ReactNode } from "react"
import PageHeader from "../components/page-header"
import ClusterScopePill from "../components/cluster-scope-pill"
import ClusterHeader from "./components/cluster-header"
import NodesCard from "./components/nodes-card"
import PrometheusAlerts from "./components/prometheus-alerts"
import ClusterMetrics from "./components/cluster-metrics"
import ClusterIOCards from "./components/cluster-io"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { NodeDrift, Readiness } from "@/lib/cluster-resources/types"
import { loadCluster } from "@/lib/features/cluster/load"
import LoadingLine from "@/app/components/loading-line"
import LoadError from "@/app/components/load-error"

const DISPLAY_ORDER: Record<Readiness, number> = {
  NotReady: 0,
  Unknown:  1,
  Ready:    2,
}

const NO_NODES = "The cluster reported no Nodes."

const isControlPlane = (n: NodeDrift) => n.role.split(",").some(r => r === "control-plane" || r === "master")

// Control plane first, then trouble first, then by name.
function sortNodes(nodes: NodeDrift[]): NodeDrift[] {
  return [...nodes].sort((a, b) =>
    Number(isControlPlane(b)) - Number(isControlPlane(a)) || DISPLAY_ORDER[a.readiness] - DISPLAY_ORDER[b.readiness] || a.name.localeCompare(b.name))
}

export default function ClusterPage() {
  const nodeDrift = useClusterState(s => s.nodeDrift)
  const isConnected = useClusterState(s => s.isConnected)
  const nodeDriftError = useClusterState(s => s.nodeDriftError)
  const alerts = useClusterState(s => s.prometheusAlerts)
  const [alertsHeight, setAlertsHeight] = useState<number | null>(null)

  useEffect(() => {
    if (!isConnected) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      await loadCluster()
      // Follow a shared boundary, with no overlapping refresh requests.
      if (!stopped) timer = setTimeout(() => void refresh(), 30_000 - Date.now() % 30_000 + 50)
    }
    void refresh()
    return () => { stopped = true; clearTimeout(timer) }
  }, [isConnected])

  const nodes = nodeDrift?.nodes ?? []

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-8 px-7 py-12">
        <PageHeader
          title="Cluster"
          subtitle="Nodes, their state and versions, and cluster resource usage"
          accessory={<ClusterScopePill />}
        />

        {nodeDrift === null ? (
          nodeDriftError
            ? <LoadError message={`Could not load nodes: ${nodeDriftError}`} />
            : isConnected
              ? <LoadingLine loading="nodes" />
              : <p className="text-sm text-muted-foreground">Waiting for cluster connection.</p>
        ) : (
          <>
            <ClusterHeader nodes={nodes} />

            {alerts && alerts.length > 0 ? (
              <div className="grid grid-cols-[3fr_2fr] gap-4 items-start">
                <PrometheusAlerts onCollapsedHeight={setAlertsHeight} />
                <ClusterMetrics matchHeight={alertsHeight} />
              </div>
            ) : (
              <ClusterMetrics matchHeight={null} />
            )}
            <ClusterIOCards />
            {nodes.length === 0 ? (
              <Notice>{NO_NODES}</Notice>
            ) : (
              <NodesCard nodes={sortNodes(nodes)} />
            )}
          </>
        )}
      </main>
    </div>
  )
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-5 py-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}
