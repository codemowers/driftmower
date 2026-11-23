"use client"

import { cn } from "@/lib/utils/cn"
import { softWrapText } from "@/lib/utils/soft-wrap-text"
import { formatBytes } from "@/lib/utils/format-bytes"
import MetricBar from "@/app/components/metric-bar"
import type { NodeDrift } from "@/lib/cluster-resources/types"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { StorageUsage } from "@/lib/features/prometheus/node-storage"
import GraphLink from "@/app/components/graph-link"
import Card from "@/app/components/layout/card"
import PrefetchLink from "@/app/components/prefetch-link"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { nodeState } from "@/lib/cluster-resources/node-state"

const GRID = "grid-cols-[2fr_1.4fr_1.4fr_1.4fr_1.2fr]"
const HEADERS = ["Name", "Memory", "LVM pool", "Ephemeral", "Version"]

const isControlPlane = (role: string) => role === "control-plane" || role === "master"

// Every Node in one card, control plane first, with its roles as badges.
export default function NodesCard({ nodes }: { nodes: NodeDrift[] }) {
  return (
    <Card title="Nodes" meta={nodes.length} flush>
      <div className={cn("grid gap-4 border-b border-gray-100 py-3 pl-8 pr-7", GRID)}>
        {HEADERS.map(h => (
          <p
            key={h}
            className="text-xs font-medium text-muted-foreground"
          >{h}</p>
        ))}
      </div>

      <div className="flex flex-col gap-2 p-3">
        {nodes.map(node => <Node key={node.name} node={node} />)}
      </div>
    </Card>
  )
}

function Node({ node }: { node: NodeDrift }) {
  const storage = useClusterState(s => s.nodeStorage?.[node.name] ?? null)
  const roles = node.role.split(",").filter(Boolean)
  const state = nodeState(node)

  return (
    <div role="group" className={cn("rounded-l-md border border-gray-200 border-l-4", state.border)} title={state.label} aria-label={`${node.name}: ${state.label}`}>
      <div className={cn("grid items-center gap-4 px-4 py-2.5", GRID)}>
        <div className="flex min-w-0 flex-col gap-1">
          <NodeName name={node.name} />
          <div className="flex flex-wrap gap-1">
            {roles.map(role => (
              <span key={role} className={cn("rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold", isControlPlane(role) ? "bg-brand-bg text-brand-label" : "bg-gray-100 text-muted-foreground")}>{role}</span>
            ))}
          </div>
        </div>

        <StorageBar usage={node.memory??undefined} />
        <StorageBar usage={storage?.lvm} />
        <StorageBar usage={storage?.ephemeral} />

        <Version version={node.version} />
      </div>
    </div>
  )
}

function NodeName({ name }: { name: string }) {
  const { linkTo } = useContextHref()
  return (
    <PrefetchLink href={linkTo(`/cluster/nodes/${encodeURIComponent(name)}`)} className="break-words font-mono text-sm font-semibold text-foreground hover:text-brand hover:underline">
      {softWrapText(name)}
    </PrefetchLink>
  )
}

function StorageBar({ usage }: { usage?: StorageUsage }) {
  if (!usage) return <span className="font-mono text-xs text-muted-foreground">—</span>
  const { used, total, graph } = usage
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <MetricBar value={used} total={total} className="h-1.5 w-full" label={`${formatBytes(used)} of ${formatBytes(total)}`} />
      <GraphLink exprs={graph} range="1w">
        <span className="font-mono text-xs text-muted-foreground">
          {formatBytes(used).replace(/ ?B$/, "").replace(/ /g, "")} / {formatBytes(total).replace(/ ?B$/, "").replace(/ /g, "")}
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
