"use client"

import { fetchMcpJSON } from "@/browser/connection"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { NodeDrift, Readiness } from "@/lib/cluster-resources/types"
import type { ClusterMetrics } from "@/lib/features/prometheus/metrics"
import type { NodeStorageMap } from "@/lib/features/prometheus/node-storage"
import type { AlertGroup, AlertSeverity } from "@/lib/features/prometheus/types"

export type HealthNode = {
  name: string
  roles: string[]
  readiness: Readiness
  conditions?: string[]
  schedulable: boolean
  pressure: NodeDrift["pressure"]
  kubeletVersion: string
  osImage: string
  kernelVersion: string
  containerRuntime: string
  architecture: string
  creationTimestamp: string
  bootTimeSeconds: number | null
  memory: {used:number;total:number;graph:string[]|null}|null
  lvm: { used: number; total: number; graph: string[] | null } | null
  ephemeral: { used: number; total: number; graph: string[] | null } | null
}

type ClusterHealth = {
  nodes: HealthNode[]
  resources: ClusterMetrics | null
}

type Alerts = { alerts: { alertname: string; severity: string }[] }

function toNode(n: HealthNode): NodeDrift {
  return {
    memory:n.memory?{used:n.memory.used,total:n.memory.total,graph:n.memory.graph??undefined}:null,
    name: n.name, role: n.roles.length ? n.roles.join(",") : "worker", readiness: n.readiness, schedulable: n.schedulable,
    pressure: n.pressure, conditions: n.conditions ?? [], version: n.kubeletVersion, osImage: n.osImage, kernelVersion: n.kernelVersion,
    containerRuntime: n.containerRuntime, architecture: n.architecture,
    creationTimestamp: n.creationTimestamp || null,
    bootTime: n.bootTimeSeconds != null && Number.isFinite(n.bootTimeSeconds) && n.bootTimeSeconds > 0
      ? new Date(n.bootTimeSeconds * 1000).toISOString() : null,
  }
}

// Firing alerts grouped by name and severity, critical first.
export function alertGroups(alerts: Alerts["alerts"]): AlertGroup[] {
  const groups = new Map<string, AlertGroup>()
  for (const a of alerts) {
    const severity: AlertSeverity = a.severity === "critical" || a.severity === "warning" ? a.severity : "other"
    const key = `${severity}/${a.alertname}`
    const group = groups.get(key) ?? { alertname: a.alertname, severity, count: 0 }
    group.count++
    groups.set(key, group)
  }
  const rank: Record<AlertSeverity, number> = { critical: 0, warning: 1, other: 2 }
  return [...groups.values()].sort((a, b) => rank[a.severity] - rank[b.severity] || b.count - a.count || a.alertname.localeCompare(b.alertname))
}

// Loads the Cluster page through the selected MCP server: nodes enriched with
// usage from get_cluster_health. Firing alerts have their own Alerts page.
export async function loadCluster(): Promise<void> {
  const health = fetchMcpJSON<ClusterHealth>("/api/observability/cluster-health")
    .then(h => {
      const storage: NodeStorageMap = {}
      const usage = (s: HealthNode["lvm"]) => (s ? { used: s.used, total: s.total, graph: s.graph ?? undefined } : undefined)
      for (const n of h.nodes) storage[n.name] = { lvm: usage(n.lvm), ephemeral: usage(n.ephemeral) }
      useClusterState.setState({ nodeDrift: { nodes: h.nodes.map(toNode) }, nodeDriftError: null, clusterMetrics: h.resources, nodeStorage: storage })
    })
    .catch((e: unknown) => useClusterState.setState({ nodeDriftError: e instanceof Error ? e.message : String(e) }))
  await health
}
