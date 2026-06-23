"use client"

import { cn } from "@/lib/utils/cn"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { ClusterMetrics } from "@/lib/cluster/prometheus/metrics"

type Memory = NonNullable<ClusterMetrics["memory"]>

const MEMORY_SEGMENTS = [
  { key: "used",    label: "Allocated", fill: "bg-status-ok-bg" },
  { key: "buffers", label: "Buffers",   fill: "bg-brand-bg" },
  { key: "cached",  label: "Cached",    fill: "bg-status-patch-bg" },
] as const

function formatBytes(bytes: number): string {
  const tb = bytes / 1e12
  if (tb >= 1) return `${tb.toFixed(1)} TB`
  const gb = bytes / 1e9
  return `${Math.round(gb)} GB`
}

function barColor(pct: number): string {
  if (pct < 0.7) return "bg-status-ok-bg"
  if (pct < 0.85) return "bg-status-minor-bg"
  return "bg-status-major-bg"
}

type UsageBarProps = {
  label: string
  value: number
  total: number
  valueLabel: string
  totalLabel: string
}

function UsageBar({ label, value, total, valueLabel, totalLabel }: UsageBarProps) {
  const pct = total > 0 ? value / total : 0

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="font-mono text-xs text-muted-foreground">{totalLabel}</span>
      </div>
      <div className="flex h-3 w-full items-stretch gap-1">
        <div
          className={cn("rounded-full transition-all", barColor(pct))}
          style={{ width: `${Math.min(pct * 100, 100)}%` }}
        />
        <div className="flex-1 rounded-full bg-gray-100" />
      </div>
      <span className="font-mono text-xs text-muted-foreground">{valueLabel}</span>
    </div>
  )
}

function MemoryBar({ memory }: { memory: Memory }) {
  const pct = (value: number) => (memory.total > 0 ? (value / memory.total) * 100 : 0)

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium text-muted-foreground">Memory</span>
        <span className="font-mono text-xs text-muted-foreground">{formatBytes(memory.total)}</span>
      </div>
      <div className="flex h-3 w-full items-stretch gap-1">
        {MEMORY_SEGMENTS.filter(seg => memory[seg.key] > 0).map(seg => (
          <div key={seg.key} className={cn("rounded-full", seg.fill)} style={{ width: `${pct(memory[seg.key])}%` }} />
        ))}
        <div className="flex-1 rounded-full bg-gray-100" />
      </div>
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

export default function ClusterMetrics({ matchHeight }: { matchHeight?: number | null }) {
  const metrics = useClusterState(s => s.clusterMetrics)

  if (!metrics || (metrics.storage === null && metrics.memory === null && metrics.pods === null && metrics.cpuLoad === null)) return null

  const hasStats = metrics.pods !== null || metrics.cpuLoad !== null

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
        {metrics.storage && (
          <UsageBar
            label="LVM Storage"
            value={metrics.storage.used}
            total={metrics.storage.total}
            valueLabel={`${formatBytes(metrics.storage.used)} allocated`}
            totalLabel={formatBytes(metrics.storage.total)}
          />
        )}
        {metrics.memory && <MemoryBar memory={metrics.memory} />}
        {hasStats && (
          <div className="flex flex-col gap-2 border-t border-gray-100 pt-4">
            {metrics.pods && (
              <>
                <StatRow label="Pending pods" value={String(metrics.pods.pending)} />
                <StatRow label="Running pods" value={`${metrics.pods.running} / ${metrics.pods.total}`} />
              </>
            )}
            {metrics.cpuLoad !== null && (
              <StatRow label="CPU load avg" value={`${metrics.cpuLoad.toFixed(2)} / core`} />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-xs text-foreground">{value}</span>
    </div>
  )
}
