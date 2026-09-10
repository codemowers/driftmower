"use client"

import { cn } from "@/lib/utils/cn"
import type { StorageClassFact } from "@/lib/features/provisioning/types"

const ROW_GRID = "grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1.6fr)_120px] items-start gap-4"

const TOPOLOGY_LABEL: Record<StorageClassFact["topology"], string> = {
  "node-local": "One node",
  zonal: "One zone",
  "cluster-wide": "Any node",
  unknown: "Unknown",
}

export default function StorageList({ classes }: { classes: StorageClassFact[] }) {
  if (classes.length === 0) {
    return <p className="text-sm text-muted-foreground">No storage classes are available on this cluster.</p>
  }

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
      <div className={cn(ROW_GRID, "border-b border-gray-200 px-5 py-2.5")}>
        {["Class", "Provisioner", "What that means", "Reachable from"].map(h => (
          <span key={h} className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {h}
          </span>
        ))}
      </div>

      {classes.map(sc => (
        <div key={sc.name} className={cn(ROW_GRID, "border-b border-gray-200 px-5 py-3 last:border-b-0")}>
          <div className="flex flex-col gap-1">
            <code className="font-mono text-xs text-foreground">{sc.name}</code>
            {sc.isDefault && <span className="text-xs text-muted-foreground">cluster default</span>}
          </div>
          <span className="font-mono text-xs text-muted-foreground">{sc.provisioner}</span>
          <span className="text-sm text-muted-foreground">{sc.implies}</span>
          {/* Node-local storage is the trap: replicas on it are copies of the
              data, not resilience against losing a machine. */}
          <span
            className={cn(
              "inline-flex w-fit rounded-md px-2 py-1 text-xs font-medium",
              sc.replicaSafe
                ? "bg-status-ok-bg text-status-ok-label"
                : "bg-status-minor-bg text-status-minor-label",
            )}
          >
            {TOPOLOGY_LABEL[sc.topology]}
          </span>
        </div>
      ))}
    </div>
  )
}
