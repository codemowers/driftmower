"use client"

import { ExternalLink } from "lucide-react"
import Card from "@/app/components/layout/card"
import PrefetchLink from "@/app/components/prefetch-link"
import { TagCell, WorstCveCell } from "@/app/components/image/image-cells"
import { LIVENESS_GUIDANCE, LivenessBadge } from "@/app/components/liveness-probe-card"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useClusterState, type LivenessProbe } from "@/lib/cluster/cluster-state"
import type { ImageUsage } from "@/lib/cluster/reports"
import { SEVERITY_STYLE } from "@/lib/cluster/styles/status-style"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { cn } from "@/lib/utils/cn"
import { digestCrumb, resolvedVersion } from "@/lib/utils/image-artifacts"

const GRID = "grid-cols-[3fr_5fr_1.5fr_1.5fr_1.5fr_1.5fr]"
const HEADERS = ["Container", "Image", "Running", "Available", "Version drift", "Worst CVE"]

// The running containers of a scope (namespace, workload or Pod) with their
// image, drift and worst CVE. Identical containers across replicas collapse
// into one row with a count; namespace scope prefixes the workload name.
export default function ImagesCard({ usages, livenessProbes = [], showWorkload = false }: { usages: ImageUsage[]; livenessProbes?: LivenessProbe[]; showWorkload?: boolean }) {
  const vulnReports = useClusterState(s => s.vulnerabilityReports)
  const { suffix: contextQuery } = useContextHref()
  const rows = new Map<string, { usage: ImageUsage; count: number }>()
  for (const u of usages) {
    if (u.finished) continue
    const key = `${u.workloadRootInfo?.uid}::${u.containerName}::${u.imageInfo.registry}/${u.imageInfo.repository}::${u.imageInfo.digest}`
    const existing = rows.get(key)
    if (existing) existing.count++
    else rows.set(key, { usage: u, count: 1 })
  }
  return (
    <Card flush title="Containers" meta={rows.size || undefined}>
      {rows.size === 0 ? <p className="px-5 py-4 text-sm text-muted-foreground">No container data available.</p> : (
        <div className="overflow-x-auto"><div className="min-w-[48rem]">
          <div className={cn("grid gap-4 border-b border-gray-200 bg-muted px-5 py-3", GRID)}>
            {HEADERS.map(h => <p key={h} className="text-xs text-muted-foreground">{h}</p>)}
          </div>
          {[...rows.values()].map(({ usage: u, count }) => {
            const vs = u.versionStatus
            const style = SEVERITY_STYLE[vs.statusType]
            const workloadUid = u.workloadRootInfo?.uid
            const repo = `${u.imageInfo.registry}/${u.imageInfo.repository}`
            const report = vulnReports === null ? undefined : vulnReports[u.imageInfo.digest] ?? null
            return (
              <div key={`${workloadUid}::${u.containerName}::${repo}::${u.imageInfo.digest}`} className={cn("grid items-center gap-4 border-b border-gray-100 px-5 py-3 last:border-0", GRID)}>
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  {showWorkload && u.workloadRootInfo && <span className="w-full truncate text-xs text-muted-foreground">{u.workloadRootInfo.name}</span>}
                  <span className="truncate font-mono text-sm font-medium">{u.containerName}</span>
                  {count > 1 && <span className="shrink-0 rounded bg-gray-100 px-1 text-xs text-muted-foreground">×{count}</span>}
                  {livenessProbes.filter(p => p.container === u.containerName).map(probe => (
                    <Tooltip key={probe.check}>
                      <TooltipTrigger asChild><span tabIndex={0} className="inline-flex rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"><LivenessBadge label="Liveness probe" /></span></TooltipTrigger>
                      <TooltipContent className="font-mono">{probe.check}</TooltipContent>
                    </Tooltip>
                  ))}
                </div>
                {u.imageInfo.digest && workloadUid ? (
                  <PrefetchLink href={`/topmost-owners/${workloadUid}/images/${encodeURIComponent(u.imageInfo.digest)}${contextQuery}`}
                    className="group flex min-w-0 flex-col font-mono text-xs text-muted-foreground hover:text-brand-text hover:underline" title={repo}>
                    <span className="inline-flex min-w-0 items-center gap-1.5"><span className="truncate">{repo}</span><ExternalLink className="size-3.5 shrink-0 group-hover:text-brand-text" /></span>
                    <span className="truncate">{digestCrumb(u.imageInfo.digest)}</span>
                  </PrefetchLink>
                ) : <span className="truncate font-mono text-xs text-muted-foreground" title={repo}>{repo}</span>}
                <TagCell tag={resolvedVersion(u) ?? vs.deployedTag} builtAt={vs.deployedBuiltAt} />
                <TagCell tag={vs.latestTag} builtAt={vs.latestBuiltAt} />
                <div><span className={cn("rounded-md px-2 py-1 text-xs font-semibold", style ? [style.bg, style.text] : "bg-gray-100 text-muted-foreground")}>{style?.label ?? "No data"}</span></div>
                <div><WorstCveCell report={report} /></div>
              </div>
            )
          })}
        </div></div>
      )}
      {livenessProbes.length > 0 && <p className="border-t border-gray-200 px-5 py-3 text-sm text-muted-foreground">{LIVENESS_GUIDANCE}</p>}
    </Card>
  )
}
