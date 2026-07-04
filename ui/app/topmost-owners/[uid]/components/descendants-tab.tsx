import Link from "next/link"
import { cn } from "@/lib/utils/cn"
import type { ClusterResource } from "@/lib/cluster/cluster-state"
import type { LinkTo } from "@/lib/hooks/use-context-href"

type Props = {
  clusterResources: ClusterResource[] | null
  reportWorkloadUid: string
  liveWorkloadUid: string
  linkTo: LinkTo
}

const PHASE_DOT: Record<string, string> = {
  Running:   "bg-status-ok",
  Pending:   "bg-status-patch",
  Failed:    "bg-status-major",
  Unknown:   "bg-status-major",
  Succeeded: "bg-gray-400",
}

type TreeRow = {
  resource: ClusterResource
  prefix: string
  depth: number
}

function buildRows(root: ClusterResource, childIndex: Map<string, ClusterResource[]>): TreeRow[] {
  const rows: TreeRow[] = [{ resource: root, prefix: "", depth: 0 }]

  function walk(parentUid: string, ancestorPipes: string) {
    const children = (childIndex.get(parentUid) ?? []).slice().sort((a, b) => {
      if (a.kind !== b.kind) return a.kind.localeCompare(b.kind)
      return a.name.localeCompare(b.name)
    })
    children.forEach((child, idx) => {
      const isLast = idx === children.length - 1
      const branch = isLast ? "└── " : "├── "
      rows.push({
        resource: child,
        prefix: ancestorPipes + branch,
        depth: ancestorPipes.length / 4 + 1,
      })
      walk(child.uid, ancestorPipes + (isLast ? "    " : "│   "))
    })
  }

  walk(root.uid, "")
  return rows
}

export default function DescendantsTab({ clusterResources, reportWorkloadUid, liveWorkloadUid, linkTo }: Props) {
  if (clusterResources === null) {
    return <p className="text-sm text-muted-foreground">Loading cluster data…</p>
  }

  const root = clusterResources.find(r => r.uid === liveWorkloadUid)
  if (!root) {
    return <p className="text-sm text-muted-foreground">No data for this workload.</p>
  }

  const childIndex = new Map<string, ClusterResource[]>()
  for (const r of clusterResources) {
    if (!r.ownerUID) continue
    const list = childIndex.get(r.ownerUID) ?? []
    list.push(r)
    childIndex.set(r.ownerUID, list)
  }

  const rows = buildRows(root, childIndex)

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200">
      <div className="flex items-center justify-between border-b border-gray-200 bg-gray-50 px-4 py-2.5">
        <p className="text-xs font-medium text-muted-foreground">
          Resource tree · <span className="text-foreground">{rows.length} {rows.length === 1 ? "object" : "objects"}</span>
        </p>
      </div>

      <div className="font-mono text-sm">
        {rows.map(({ resource: r, prefix, depth }, idx) => {
          const isRoot = depth === 0
          const childCount = (childIndex.get(r.uid) ?? []).length
          const isEmptyReplicaSet = r.kind === "ReplicaSet" && childCount === 0
          const dim = isEmptyReplicaSet

          const isPod = r.kind === "Pod"
          const podHref = isPod
            ? linkTo(`/topmost-owners/${reportWorkloadUid}/${r.uid}`, { drop: ["ptab"] })
            : null

          const rowClassName = cn(
            "flex items-center gap-3 px-4 py-3",
            idx > 0 && "border-t border-gray-100",
            podHref && "transition-colors hover:bg-brand-bg/30",
          )

          const inner = (
            <>
              {prefix && (
                <span className="whitespace-pre text-gray-400">{prefix}</span>
              )}

              {isPod && (
                <span className={cn("size-2.5 shrink-0 rounded-full", PHASE_DOT[r.phase ?? ""] ?? "bg-gray-400")} />
              )}

              {isRoot ? (
                <span className="rounded bg-brand-bg px-1.5 py-0.5 text-xs font-semibold text-brand-label">
                  {r.kind}
                </span>
              ) : (
                <span className={cn("text-xs", dim ? "text-muted-foreground/60" : "text-muted-foreground")}>
                  {r.kind}
                </span>
              )}

              <span className={cn("truncate", dim ? "text-muted-foreground/70" : "text-foreground")}>
                {r.name}
              </span>

              {isEmptyReplicaSet && (
                <span className="text-xs text-muted-foreground/60">· empty</span>
              )}

              {r.kind === "ReplicaSet" && childCount > 0 && (
                <span className="text-xs text-muted-foreground">· {childCount} {childCount === 1 ? "pod" : "pods"}</span>
              )}

              {isPod && (r.nodeName || r.ips?.[0]) && (
                <>
                  {r.nodeName && (
                    <span className="ml-auto text-xs text-muted-foreground">{r.nodeName}</span>
                  )}
                  {r.ips?.[0] && (
                    <span className={cn("text-xs text-muted-foreground", !r.nodeName && "ml-auto")}>{r.ips[0]}</span>
                  )}
                </>
              )}
            </>
          )

          return podHref ? (
            <Link key={r.uid} href={podHref} className={rowClassName}>
              {inner}
            </Link>
          ) : (
            <div key={r.uid} className={rowClassName}>
              {inner}
            </div>
          )
        })}
      </div>
    </div>
  )
}
