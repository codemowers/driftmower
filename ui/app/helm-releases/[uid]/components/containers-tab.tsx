import Link from "next/link"
import { AlertTriangle, ExternalLink } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import { relativeTimeFromNow } from "@/lib/utils/format-time"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { ImageUsage, Issue } from "@/lib/cluster/reports"
import { SEVERITY_STYLE } from "@/lib/cluster/status-style"

function TagCell({ tag, builtAt }: { tag: string | null; builtAt?: string }) {
  return (
    <div className="flex flex-col">
      <span className="font-mono text-sm text-foreground">{tag ?? "—"}</span>
      {builtAt && (
        <Tooltip>
          <TooltipTrigger asChild>
            <time dateTime={builtAt} className="font-mono text-xs text-muted-foreground">
              {relativeTimeFromNow(builtAt)}
            </time>
          </TooltipTrigger>
          <TooltipContent>{builtAt}</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

type Props = {
  usages: ImageUsage[]
  issues: Issue[]
  reportId: string | null
}

const GRID = "grid-cols-[3fr_5fr_1.5fr_1.5fr_1.5fr]"
const HEADERS = ["Container", "Image", "Running", "Available", "Version drift"]

export default function ContainersTab({ usages, issues, reportId }: Props) {

  const workloadMap = usages.reduce<Map<string, ImageUsage[]>>((map, u) => {
    if (!u.workloadRootInfo) return map
    const { kind, name, namespace } = u.workloadRootInfo
    const key = `${kind}/${namespace}/${name}`
    const group = map.get(key) ?? []
    group.push(u)
    map.set(key, group)
    return map
  }, new Map())

  if (workloadMap.size === 0) {
    return <p className="text-sm text-muted-foreground">No container data available.</p>
  }

  return (
    <div className="flex flex-col gap-6">
      {Array.from(workloadMap.entries()).map(([workloadKey, containers]) => {
        const { kind, name, namespace, uid: workloadUid } = containers[0].workloadRootInfo!
        const workloadHref = reportId
          ? `/topmost-owners/${workloadUid}?report=${reportId}`
          : `/topmost-owners/${workloadUid}`

        const deduped = new Map<string, { usage: ImageUsage; count: number }>()
        for (const u of containers) {
          const key = `${u.containerName}::${u.imageInfo.registry}/${u.imageInfo.repository}`
          const existing = deduped.get(key)
          if (existing) existing.count++
          else deduped.set(key, { usage: u, count: 1 })
        }

        return (
          <div key={workloadKey} className="overflow-hidden rounded-xl border border-gray-200">
            <Link
              href={workloadHref}
              className="flex items-center gap-3 border-b border-gray-200 bg-gray-50 px-4 py-2.5 transition-colors hover:bg-brand-bg/30"
            >
              <span className="rounded bg-brand-bg px-1.5 py-0.5 text-xs font-semibold text-brand-label">
                {kind}
              </span>
              <span className="text-sm font-semibold text-foreground">{name}</span>
              <span className="font-mono text-xs text-muted-foreground">{namespace}</span>
            </Link>

            {/* Column headers */}
            <div className={cn("grid gap-4 border-b border-gray-100 px-4 py-3", GRID)}>
              {HEADERS.map(h => (
                <p key={h} className="text-xs font-medium text-muted-foreground">{h}</p>
              ))}
            </div>

            {/* Container rows */}
            <div>
              {Array.from(deduped.values()).map(({ usage: u, count }, idx) => {
                const vs = u.versionStatus
                const statusStyle = SEVERITY_STYLE[vs.statusType]
                const issue = issues.find(i => u.image.includes(i.image))

                return (
                  <div
                    key={`${u.containerName}::${u.image}`}
                    className={cn(
                      idx > 0 && "border-t border-gray-100"
                    )}
                  >
                    <div className={cn("grid items-center gap-4 px-4 py-3", GRID)}>
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-mono text-sm font-semibold text-foreground">
                          {u.containerName}
                        </span>
                        {count > 1 && (
                          <span className="shrink-0 rounded bg-gray-100 px-1 text-xs text-muted-foreground">
                            ×{count}
                          </span>
                        )}
                      </div>
                      <Link
                        href={`/topmost-owners/${workloadUid}/images/${encodeURIComponent(u.imageInfo.digest)}${reportId ? `?report=${reportId}` : ""}`}
                        className="group inline-flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground hover:text-brand-text hover:underline"
                      >
                        <span className="truncate">{u.imageInfo.registry}/{u.imageInfo.repository}</span>
                        <ExternalLink className="size-3.5 shrink-0 text-muted-foreground group-hover:text-brand-text" />
                      </Link>
                      <TagCell tag={vs.deployedTag} builtAt={vs.deployedBuiltAt} />
                      <TagCell tag={vs.latestTag}   builtAt={vs.latestBuiltAt} />
                      <div>
                        {statusStyle ? (
                          <span className={cn("rounded-md px-2 py-1 text-xs font-semibold", statusStyle.bg, statusStyle.text)}>
                            {statusStyle.label}
                          </span>
                        ) : (
                          <span className="rounded-md bg-gray-100 px-2 py-1 text-xs font-semibold text-muted-foreground">
                            No data
                          </span>
                        )}
                      </div>
                    </div>
                    {issue && (
                      <div className="flex items-center gap-2 px-5 pb-4">
                        <AlertTriangle className="size-3.5 shrink-0 text-status-minor-label" />
                        <span className="text-xs text-status-minor-label">{`${issue.type}: ${issue.message}`}</span>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
