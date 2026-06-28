"use client"

import { Fragment } from "react"
import { cn } from "@/lib/utils/cn"
import { kubectlAge } from "@/lib/utils/format-time"
import { formatBytes } from "@/lib/utils/format-bytes"
import { usageBarColor } from "@/lib/utils/usage-color"
import type { NodeDrift, Readiness, SupportSeverity } from "@/lib/api/cluster-resources/types"
import { useClusterState } from "@/lib/cluster/cluster-state"

const GRID = "grid-cols-[1.8fr_1.6fr_2.3fr_1.6fr_1.3fr_0.3fr]"
const HEADERS = ["Name", "State", "Storage", "Version", "Support", "Age"]

const PILL: Record<SupportSeverity, { bg: string; text: string }> = {
  ok:       { bg: "bg-status-ok-bg",    text: "text-status-ok-label" },
  ending:   { bg: "bg-status-patch-bg", text: "text-status-patch-label" },
  urgent:   { bg: "bg-status-minor-bg", text: "text-status-minor-label" },
  extended: { bg: "bg-status-minor-bg", text: "text-status-minor-label" },
  eol:      { bg: "bg-status-major-bg", text: "text-status-major-label" },
  unknown:  { bg: "bg-gray-100",        text: "text-muted-foreground" },
}

const SPINE: Record<SupportSeverity, string> = {
  ok:       "border-l-status-ok",
  ending:   "border-l-status-patch",
  urgent:   "border-l-status-minor",
  extended: "border-l-status-minor",
  eol:      "border-l-status-major",
  unknown:  "border-l-gray-300",
}

type Props = {
  role: string
  nodes: NodeDrift[]
  isControlPlane: boolean
}

export default function NodeRoleCard({ role, nodes, isControlPlane }: Props) {
  return (
    <div className="rounded-xl border border-gray-200">
      <header
        className={cn(
          "flex items-center gap-3 border-b border-gray-200 px-4 py-3.5",
          isControlPlane ? "bg-brand-bg/40" : "bg-gray-50",
        )}
      >
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-mono text-xs font-semibold",
            isControlPlane ? "bg-brand-bg text-brand-label" : "bg-gray-100 text-muted-foreground",
          )}
        >
          {role}
        </span>
        <span className="text-xs text-muted-foreground">
          {nodes.length} node{nodes.length !== 1 ? "s" : ""}
        </span>
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
  const pill = PILL[node.support.severity]
  const storage = useClusterState(s => s.nodeStorage?.[node.name] ?? null)

  return (
    <div className={cn("rounded-l-md border border-gray-200 border-l-4", SPINE[node.support.severity])}>
      <div className={cn("grid items-center gap-4 px-4 py-2.5", GRID)}>
        <NodeName name={node.name} />

        <State readiness={node.readiness} schedulable={node.schedulable} />

        {storage
          ? <StorageBar used={storage.used} total={storage.total} />
          : <span className="font-mono text-xs text-muted-foreground">—</span>
        }

        <Version version={node.version} />

        <div>
          <span className={cn("rounded-md px-2.5 py-1.5 text-xs font-semibold", pill.bg, pill.text)}>
            {node.support.label}{node.support.relative && ` · ${node.support.relative}`}
          </span>
        </div>

        <span className="font-mono text-sm text-muted-foreground tabular-nums text-right">
          {node.creationTimestamp ? kubectlAge(node.creationTimestamp) : "—"}
        </span>
      </div>
    </div>
  )
}

function withBreaks(text: string) {
  const segments = text.split(/(?<=[-.])/)
  return segments.map((segment, i) => (
    <Fragment key={i}>
      {segment}
      {i < segments.length - 1 && <wbr />}
    </Fragment>
  ))
}

function NodeName({ name }: { name: string }) {
  return (
    <span className="break-words font-mono text-sm font-semibold text-foreground">
      {withBreaks(name)}
    </span>
  )
}

function State({ readiness, schedulable }: { readiness: Readiness; schedulable: boolean }) {
  const dot =
    readiness === "Ready" ? "bg-status-ok" : readiness === "NotReady" ? "bg-status-major" : "bg-gray-400"
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className={cn("size-2 shrink-0 rounded-full", dot)} aria-hidden />
      <span className="truncate text-sm text-foreground">
        {readiness}
        {!schedulable && <span className="text-muted-foreground">,SchedulingDisabled</span>}
      </span>
    </div>
  )
}

function StorageBar({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? used / total : 0
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-[120px] shrink-0 overflow-hidden rounded-full bg-gray-100">
        <div
          className={cn("h-full rounded-full", usageBarColor(pct))}
          style={{ width: `${Math.min(pct * 100, 100)}%` }}
        />
      </div>
      <span className="font-mono text-xs text-muted-foreground">
        {formatBytes(used)} / {formatBytes(total)}
      </span>
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
