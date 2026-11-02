"use client"

import PrefetchLink from "@/app/components/prefetch-link"
import { cn } from "@/lib/utils/cn"
import type { LinkTo } from "@/lib/hooks/use-context-href"
import type { ImageWorkloadRow } from "../../utils/image-entries"

const GRID = "grid-cols-[minmax(0,2.5fr)_minmax(0,1.4fr)_minmax(0,0.8fr)]"
const GRID_WITH_VERSIONS = "grid-cols-[minmax(0,2.2fr)_minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,1fr)]"

const SCROLL_HEIGHT = "max-h-[280px]"

function versionLabel(row: ImageWorkloadRow): string {
  if (row.versions.length === 0) return "—"
  if (row.versions.length === 1) return row.versions[0]
  return `${row.versions.length} versions`
}

export default function DeployedByCard({
  rows,
  containerCount,
  namespaceCount,
  showVersions,
  linkTo,
}: {
  rows: ImageWorkloadRow[]
  containerCount: number
  namespaceCount: number
  showVersions: boolean
  linkTo: LinkTo
}) {
  const grid = showVersions ? GRID_WITH_VERSIONS : GRID
  const totals = [
    `${rows.length} workload${rows.length === 1 ? "" : "s"}`,
    `${containerCount} container${containerCount === 1 ? "" : "s"}`,
    `${namespaceCount} namespace${namespaceCount === 1 ? "" : "s"}`,
  ].join(", ")

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-white">
      <div className="flex items-baseline justify-between gap-4 border-b border-gray-200 px-5 py-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Deployed by</p>
        <p className="shrink-0 text-xs text-muted-foreground">{totals}</p>
      </div>

      <div className={cn("overflow-y-auto", SCROLL_HEIGHT)}>
        <div className={cn("sticky top-0 z-10 grid gap-4 border-b border-gray-100 bg-white px-5 py-3", grid)}>
          <p className="text-xs font-medium text-muted-foreground">Workload</p>
          <p className="text-xs font-medium text-muted-foreground">Namespace</p>
          <p className="text-xs font-medium text-muted-foreground">Containers</p>
          {showVersions && <p className="text-xs font-medium text-muted-foreground">Running</p>}
        </div>

        <div className="divide-y divide-gray-100">
          {rows.length > 0 ? (
            rows.map(row => (
              <PrefetchLink
                key={row.uid}
                href={linkTo(`/topmost-owners/${row.uid}`, { drop: ["wtab"] })}
                className={cn("grid items-center gap-4 px-5 py-3 transition-colors hover:bg-brand-bg/40", grid)}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 rounded-md bg-brand-bg px-2 py-0.5 text-xs font-semibold text-brand-label">
                    {row.kind}
                  </span>
                  <span className="truncate text-sm font-medium text-foreground">{row.name}</span>
                </div>
                <span className="truncate font-mono text-xs text-muted-foreground">{row.namespace}</span>
                <span className="text-sm tabular-nums text-foreground">{row.containerCount}</span>
                {showVersions && (
                  <span className="truncate font-mono text-xs text-foreground">{versionLabel(row)}</span>
                )}
              </PrefetchLink>
            ))
          ) : (
            <p className="px-5 py-6 text-sm text-muted-foreground">
              No workload owner recorded for these containers.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
