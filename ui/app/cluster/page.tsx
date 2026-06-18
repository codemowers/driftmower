"use client"

import type { ReactNode } from "react"
import PageHeader from "../components/page-header"
import ClusterHeader from "./components/cluster-header"
import NodeRoleCard from "./components/node-role-card"
import PrometheusAlerts from "./components/prometheus-alerts"
import ClusterMetrics from "./components/cluster-metrics"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { StatusType } from "@/lib/cluster/reports"
import type { NodeDrift } from "@/lib/api/cluster-resources/types"

const DISPLAY_ORDER: Record<StatusType, number> = {
  major_behind: 0,
  minor_behind: 1,
  patch_behind: 2,
  up_to_date:   3,
  ahead:        4,
  no_data:      5,
  no_version:   5,
}

const NOT_IN_CLUSTER =
  "No nodes found. The Cluster page reads nodes from the Kubernetes API, which is unavailable when not running in-cluster."

type RoleGroup = { role: string; nodes: NodeDrift[]; isControlPlane: boolean }

function groupByRole(nodes: NodeDrift[]): RoleGroup[] {
  const map = new Map<string, NodeDrift[]>()
  for (const node of nodes) {
    const group = map.get(node.role) ?? []
    group.push(node)
    map.set(node.role, group)
  }

  return Array.from(map.entries())
    .map(([role, groupNodes]) => ({
      role,
      nodes: groupNodes.sort((a, b) => DISPLAY_ORDER[a.statusType] - DISPLAY_ORDER[b.statusType]),
      isControlPlane: role.includes("control-plane"),
    }))
    .sort((a, b) =>
      a.isControlPlane !== b.isControlPlane
        ? Number(b.isControlPlane) - Number(a.isControlPlane)
        : a.role.localeCompare(b.role),
    )
}

export default function ClusterPage() {
  const nodeDrift = useClusterState(s => s.nodeDrift)
  const isConnected = useClusterState(s => s.isConnected)

  const nodes = nodeDrift?.nodes ?? []
  const groups = groupByRole(nodes)

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-8 px-7 py-12">
        <PageHeader title="Cluster" subtitle="Nodes and Kubernetes version drift" />

        {nodeDrift === null ? (
          <p className="text-sm text-muted-foreground">
            {isConnected ? "Loading nodes…" : "Waiting for cluster connection."}
          </p>
        ) : (
          <>
            <ClusterHeader reference={nodeDrift.reference} nodeCount={nodes.length} />

            <div className="grid grid-cols-[3fr_2fr] gap-4 items-stretch">
              <PrometheusAlerts />
              <ClusterMetrics />
            </div>
            {nodeDrift.error ? (
              <Notice>{nodeDrift.error}</Notice>
            ) : nodes.length === 0 ? (
              <Notice>{NOT_IN_CLUSTER}</Notice>
            ) : (
              <div className="flex flex-col gap-6">
                {groups.map(group => (
                  <NodeRoleCard
                    key={group.role}
                    role={group.role}
                    nodes={group.nodes}
                    isControlPlane={group.isControlPlane}
                  />
                ))}
              </div>
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
