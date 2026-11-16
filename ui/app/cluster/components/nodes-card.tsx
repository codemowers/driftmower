"use client"

import { cn } from "@/lib/utils/cn"
import { softWrapText } from "@/lib/utils/soft-wrap-text"
import { kubectlAge } from "@/lib/utils/format-time"
import { formatBytes } from "@/lib/utils/format-bytes"
import { usageBarColor } from "@/lib/utils/usage-color"
import type { NodeDrift, Readiness } from "@/lib/cluster-resources/types"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { StorageUsage } from "@/lib/features/prometheus/node-storage"
import GraphLink from "@/app/components/graph-link"

const GRID = "grid-cols-[2fr_1.4fr_1.6fr_1.6fr_1.4fr_0.4fr]"
const HEADERS = ["Name", "State", "LVM pool", "Ephemeral", "Version", "Age"]

const SPINE: Record<Readiness, string> = {
  Ready:    "border-l-status-ok",
  NotReady: "border-l-status-major",
  Unknown:  "border-l-gray-300",
}

const isControlPlane = (role: string) => role === "control-plane" || role === "master"

// Every Node in one card, control plane first, with its roles as badges.
export default function NodesCard({ nodes }: { nodes: NodeDrift[] }) {
  return (
    <div className="rounded-xl border border-gray-200">
      <header className="flex items-center gap-3 border-b border-gray-200 bg-gray-50 px-4 py-3.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Nodes</span>
        <span className="text-xs text-muted-foreground">{nodes.length}</span>
      </header>

      <div className={cn("grid gap-4 border-b border-gray-100 py-3 pl-8 pr-7", GRID)}>
        {HEADERS.map((h, i) => (
          <p
            key={h}
            className={cn("text-xs font-medium text-muted-foreground", i === HEADERS.length - 1 && "text-right")}
          >{h}</p>
        ))}
      </div>

      <div className="flex flex-col gap-2 p-3">
        {nodes.map(node => <Node key={node.name} node={node} />)}
      </div>
    </div>
  )
}

function Node({ node }: { node: NodeDrift }) {
  const storage = useClusterState(s => s.nodeStorage?.[node.name] ?? null)
  const roles = node.role.split(",").filter(Boolean)

  return (
    <div className={cn("rounded-l-md border border-gray-200 border-l-4", SPINE[node.readiness])}>
      <div className={cn("grid items-center gap-4 px-4 py-2.5", GRID)}>
        <div className="flex min-w-0 flex-col gap-1">
          <NodeName name={node.name} />
          <div className="flex flex-wrap gap-1">
            {roles.map(role => (
              <span key={role} className={cn("rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold", isControlPlane(role) ? "bg-brand-bg text-brand-label" : "bg-gray-100 text-muted-foreground")}>{role}</span>
            ))}
          </div>
        </div>

        <State readiness={node.readiness} schedulable={node.schedulable} pressure={node.pressure} />

        <StorageBar usage={storage?.lvm} />
        <StorageBar usage={storage?.ephemeral} />

        <Version version={node.version} />

        <span className="font-mono text-sm text-muted-foreground tabular-nums text-right">
          {node.creationTimestamp ? kubectlAge(node.creationTimestamp) : "—"}
        </span>
      </div>
    </div>
  )
}

function NodeName({ name }: { name: string }) {
  return (
    <span className="break-words font-mono text-sm font-semibold text-foreground">
      {softWrapText(name)}
    </span>
  )
}

function State({ readiness, schedulable, pressure }: { readiness: Readiness; schedulable: boolean; pressure: NodeDrift["pressure"] }) {
  const pressures = [pressure.memory && "MemoryPressure", pressure.disk && "DiskPressure", pressure.pid && "PIDPressure"].filter(Boolean)
  const dot =
    readiness === "Ready" ? "bg-status-ok" : readiness === "NotReady" ? "bg-status-major" : "bg-gray-400"
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className={cn("size-2 shrink-0 rounded-full", dot)} aria-hidden />
      <span className="truncate text-sm text-foreground">
        {readiness}
        {!schedulable && <span className="text-muted-foreground">,SchedulingDisabled</span>}
        {pressures.length > 0 && <span className="text-status-major-label">,{pressures.join(",")}</span>}
      </span>
    </div>
  )
}

function StorageBar({ usage }: { usage?: StorageUsage }) {
  if (!usage) return <span className="font-mono text-xs text-muted-foreground">—</span>
  const { used, total, graph } = usage
  const pct = total > 0 ? used / total : 0
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-gray-100">
        <div
          className={cn("h-full rounded-full", usageBarColor(pct))}
          style={{ width: `${Math.min(pct * 100, 100)}%` }}
        />
      </div>
      <GraphLink exprs={graph} range="1w">
        <span className="font-mono text-xs text-muted-foreground">
          {formatBytes(used)} / {formatBytes(total)}
        </span>
      </GraphLink>
    </div>
  )
}

function Version({ version }: { version: string }) {
  if (!version) return <span className="font-mono text-sm text-muted-foreground">—</span>
  const plus = version.indexOf("+")
  if (plus === -1) return <span className="font-mono text-sm text-foreground">{version}</span>
  return (
    <span className="truncate font-mono text-sm text-foreground">
      {version.slice(0, plus)}
      <span className="text-muted-foreground">{version.slice(plus)}</span>
    </span>
  )
}
