import { cn } from "@/lib/utils"
import { kubectlAge } from "@/lib/format-time"
import type { StatusType } from "@/lib/cluster/reports"
import type { NodeDrift, Readiness } from "@/lib/api/cluster-resources/types"

const GRID = "grid-cols-[1.6fr_2fr_0.8fr_1.8fr_2.4fr]"
const HEADERS = ["Name", "State", "Age", "Version", "Version drift"]

const SEVERITY_STYLE: Partial<Record<StatusType, { bg: string; text: string; label: string }>> = {
  major_behind: { bg: "bg-status-major-bg", text: "text-status-major-label", label: "Major" },
  minor_behind: { bg: "bg-status-minor-bg", text: "text-status-minor-label", label: "Minor" },
  patch_behind: { bg: "bg-status-patch-bg", text: "text-status-patch-label", label: "Patch" },
  up_to_date:   { bg: "bg-status-ok-bg",    text: "text-status-ok-label",    label: "OK" },
  ahead:        { bg: "bg-status-ok-bg",    text: "text-status-ok-label",    label: "Ahead" },
}

const SPINE: Partial<Record<StatusType, string>> = {
  up_to_date:   "border-l-status-ok",
  ahead:        "border-l-status-ok",
  patch_behind: "border-l-status-patch",
  minor_behind: "border-l-status-minor",
  major_behind: "border-l-status-major",
}

const BEHIND: StatusType[] = ["patch_behind", "minor_behind", "major_behind"]

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
        {HEADERS.map(h => (
          <p key={h} className="text-xs font-medium text-muted-foreground">{h}</p>
        ))}
      </div>

      <div className="flex flex-col gap-2 p-3">
        {nodes.map(node => <Node key={node.name} node={node} />)}
      </div>
    </div>
  )
}

function Node({ node }: { node: NodeDrift }) {
  const badge = SEVERITY_STYLE[node.statusType]
  const showArrow = BEHIND.includes(node.statusType) && node.target

  return (
    <div className={cn("rounded-l-md border border-gray-200 border-l-4", SPINE[node.statusType] ?? "border-l-gray-300")}>
      <div className={cn("grid items-center gap-4 px-4 py-2.5", GRID)}>
        <span className="truncate font-mono text-sm font-semibold text-foreground">{node.name}</span>

        <State readiness={node.readiness} schedulable={node.schedulable} />

        <span className="font-mono text-sm text-muted-foreground tabular-nums">
          {node.creationTimestamp ? kubectlAge(node.creationTimestamp) : "—"}
        </span>

        <Version version={node.version} />

        <div className="flex items-center gap-2">
          {badge ? (
            <span className={cn("rounded-md px-2 py-1 text-xs font-semibold", badge.bg, badge.text)}>{badge.label}</span>
          ) : (
            <span className="rounded-md bg-gray-100 px-2 py-1 text-xs font-semibold text-muted-foreground">No data</span>
          )}
          {showArrow && (
            <span className="font-mono text-xs text-muted-foreground">→ {node.target}</span>
          )}
        </div>
      </div>
    </div>
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
