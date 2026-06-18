"use client"

import { cn } from "@/lib/utils/cn"
import { useClusterState } from "@/lib/cluster/cluster-state"

function formatBytes(bytes: number): string {
  const tb = bytes / 1e12
  if (tb >= 1) return `${tb.toFixed(1)} TB`
  const gb = bytes / 1e9
  return `${Math.round(gb)} GB`
}

function barColor(pct: number): string {
  if (pct < 0.7) return "bg-status-ok"
  if (pct < 0.85) return "bg-status-minor"
  return "bg-status-major"
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
      <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
        <div
          className={cn("h-full rounded-full transition-all", barColor(pct))}
          style={{ width: `${Math.min(pct * 100, 100)}%` }}
        />
      </div>
      <span className="font-mono text-xs text-muted-foreground">{valueLabel}</span>
    </div>
  )
}

export default function ClusterMetrics() {
  const metrics = useClusterState(s => s.clusterMetrics)

  if (!metrics || (metrics.storage === null && metrics.memory === null && metrics.pods === null && metrics.cpuLoad === null)) return null

  const hasStats = metrics.pods !== null || metrics.cpuLoad !== null

  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <header className="border-b border-gray-200 px-5 py-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Cluster resources
        </span>
      </header>

      <div className="flex flex-col gap-5 px-5 py-4">
        {metrics.storage && (
          <UsageBar
            label="LVM Storage"
            value={metrics.storage.used}
            total={metrics.storage.total}
            valueLabel={`${formatBytes(metrics.storage.used)} used`}
            totalLabel={formatBytes(metrics.storage.total)}
          />
        )}
        {metrics.memory && (
          <UsageBar
            label="Memory cache"
            value={metrics.memory.cached}
            total={metrics.memory.total}
            valueLabel={`${formatBytes(metrics.memory.cached)} cached`}
            totalLabel={formatBytes(metrics.memory.total)}
          />
        )}
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
