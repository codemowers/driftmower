"use client"

import { useMemo, type ReactNode } from "react"
import MetricBar from "@/app/components/metric-bar"
import { formatBytes } from "@/lib/utils/format-bytes"
import { useClusterState, type ClusterResource } from "@/lib/cluster/cluster-state"
import type { Report } from "@/lib/cluster/reports"
import { findWorkloadRoot } from "@/lib/cluster/workload-root"
import { summarizePodsByRoot } from "@/lib/utils/pods-by-root"
import { reportWorkloadRoots } from "@/lib/utils/report-roots"
import type { ClusterMetrics } from "@/lib/features/prometheus/metrics"
import GraphLink from "@/app/components/graph-link"

type Memory = NonNullable<ClusterMetrics["memory"]>

const MEMORY_SEGMENTS = [
  { key: "used",    label: "Allocated", fill: "bg-status-ok" },
  { key: "buffers", label: "Buffers",   fill: "bg-brand" },
  { key: "cached",  label: "Cached",    fill: "bg-status-patch" },
] as const

type UsageBarProps = {
  graph?: string[]
  label: string
  value: number
  total: number
  valueLabel: ReactNode
  totalLabel: ReactNode
}

function UsageBar({ graph, label, value, total, valueLabel, totalLabel }: UsageBarProps) {

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <GraphLink exprs={graph}><span className="text-xs font-medium text-muted-foreground">{label}</span></GraphLink>
        <span className="font-mono text-xs text-muted-foreground">{totalLabel}</span>
      </div>
      <MetricBar value={value} total={total} className="h-3" />
      <span className="font-mono text-xs text-muted-foreground">{valueLabel}</span>
    </div>
  )
}

function MemoryBar({ memory, graph }: { memory: Memory; graph?: string[] }) {

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <GraphLink exprs={graph}><span className="text-xs font-medium text-muted-foreground">Memory</span></GraphLink>
        <span className="font-mono text-xs text-muted-foreground">{formatBytes(memory.total)}</span>
      </div>
      <MetricBar total={memory.total} segments={MEMORY_SEGMENTS.map(seg=>({key:seg.key,value:memory[seg.key],color:seg.fill}))} className="h-3" />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {MEMORY_SEGMENTS.map(seg => (
          <span key={seg.key} className="font-mono text-xs text-muted-foreground">
            {seg.label} {formatBytes(memory[seg.key])}
          </span>
        ))}
      </div>
    </div>
  )
}

type PodStats = { total: number; healthy: number; failed: number; unknown: number; pending: number }

const COUNTED_SEVERITIES = ["healthy", "failed", "unknown", "pending"] as const

function countReportedPods(data: Report, resources: ClusterResource[]): PodStats {
  const summaries = summarizePodsByRoot(resources)
  const stats: PodStats = { total: 0, healthy: 0, failed: 0, unknown: 0, pending: 0 }

  for (const root of reportWorkloadRoots(data)) {
    const liveRoot = findWorkloadRoot(resources, root)
    const summary = liveRoot ? summaries.get(liveRoot.uid) : undefined
    if (!summary) continue
    stats.total += summary.total
    for (const severity of COUNTED_SEVERITIES) stats[severity] += summary.counts[severity]
  }

  return stats
}

const ATTENTION_SEVERITIES = ["failed", "unknown", "pending"] as const

function attentionLabel(stats: PodStats): ReactNode {
  const parts = ATTENTION_SEVERITIES
    .filter(severity => stats[severity] > 0)
    .map(severity => `${stats[severity]} ${severity}`)
  if (parts.length === 0) return <span className="text-muted-foreground">none</span>
  return parts.join(" · ")
}

export default function ClusterMetrics({ matchHeight }: { matchHeight?: number | null }) {
  const metrics = useClusterState(s => s.clusterMetrics)
  const clusterResources = useClusterState(s => s.clusterResources)
  const data = useClusterState(s => s.data)

  const podStats = useMemo(
    () => (data && clusterResources ? countReportedPods(data, clusterResources) : null),
    [data, clusterResources],
  )
  const metricsEmpty = !metrics || (metrics.storage === null && metrics.memory === null && metrics.cpu === null)
  if (metricsEmpty && !podStats) return null

  const hasStats = podStats !== null || (metrics?.cpu ?? null) !== null

  return (
    <div
      className="rounded-xl border border-gray-200 bg-white"
      style={matchHeight ? { minHeight: matchHeight } : undefined}
    >
      <header className="border-b border-gray-200 px-5 py-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Cluster resources
        </span>
      </header>

      <div className="flex flex-col gap-4 px-5 py-4">
        {metrics?.storage && (
          <UsageBar
            graph={metrics.graphs?.storage}
            label="LVM Storage"
            value={metrics.storage.used}
            total={metrics.storage.total}
            valueLabel={`${formatBytes(metrics.storage.used)} allocated`}
            totalLabel={formatBytes(metrics.storage.total)}
          />
        )}
        {metrics?.memory && <MemoryBar memory={metrics.memory} graph={metrics.graphs?.memory} />}
        {metrics?.buckets?.usage != null && (
          <UsageBar
            graph={metrics.graphs?.buckets}
            label={`Buckets · ${metrics.buckets.count}`}
            value={metrics.buckets.usage}
            total={metrics.buckets.requests ?? 0}
            valueLabel={`${formatBytes(metrics.buckets.usage)} used`}
            totalLabel={metrics.buckets.requests != null ? `${formatBytes(metrics.buckets.requests)} quota` : "no quota"}
          />
        )}
        {hasStats && (
          <div className="flex flex-col gap-2 border-t border-gray-100 pt-4">
            {podStats && (
              <>
                <StatRow label="Pods" value={`${podStats.healthy} healthy / ${podStats.total}`} />
                <StatRow label="Attention" value={attentionLabel(podStats)} />
              </>
            )}
            {metrics?.cpu && (
              <StatRow label="CPU used" value={<GraphLink exprs={metrics.graphs?.cpu}>{`${metrics.cpu.used.toFixed(1)} / ${Math.round(metrics.cpu.capacity)} cores`}</GraphLink>} />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function StatRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-xs text-foreground">{value}</span>
    </div>
  )
}
