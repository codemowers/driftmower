import PrefetchLink from "@/app/components/prefetch-link"
import { ArrowRight } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import type { ImageUsage } from "@/lib/cluster/reports"
import { SEVERITY_STYLE } from "@/lib/cluster/styles/status-style"

type ContainerEntry = {
  containerName: string
  imageLabel: string
  repoKey: string
  count: number
  usage: ImageUsage
}

function collectContainers(usages: ImageUsage[]): ContainerEntry[] {
  const entries = new Map<string, ContainerEntry>()
  for (const usage of usages) {
    const key = `${usage.containerName}|${usage.image}`
    const existing = entries.get(key)
    if (existing) {
      existing.count++
      continue
    }
    const { registry, repository, tag } = usage.imageInfo
    entries.set(key, {
      containerName: usage.containerName,
      imageLabel: `${registry}/${repository}:${tag}`,
      repoKey: `${registry}/${repository}`,
      count: 1,
      usage,
    })
  }
  return Array.from(entries.values())
}

function ContainerRow({ entry, reportId, first }: { entry: ContainerEntry; reportId: string | null; first: boolean }) {
  const { usage } = entry
  const style = SEVERITY_STYLE[usage.versionStatus.statusType]
  const workloadUid = usage.workloadRootInfo?.uid

  const inner = (
    <>
      <span className="shrink-0 font-mono text-[13px] text-foreground">{entry.containerName}</span>
      {entry.count > 1 && (
        <span className="shrink-0 rounded-md bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
          ×{entry.count}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
        {entry.imageLabel}
      </span>
      {style ? (
        <span className={cn("shrink-0 rounded-md px-2.5 py-1 text-xs font-semibold", style.bg, style.text)}>
          {style.label}
        </span>
      ) : (
        <span className="shrink-0 rounded-md bg-gray-100 px-2.5 py-1 text-xs font-semibold text-muted-foreground">
          No data
        </span>
      )}
      <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
    </>
  )

  const rowClass = cn(
    "flex items-center gap-3 px-4 py-3 transition-colors hover:bg-brand-bg/30",
    !first && "border-t border-gray-100",
  )

  if (!workloadUid || !usage.imageInfo.digest) {
    return <div className={rowClass}>{inner}</div>
  }

  const digest = encodeURIComponent(usage.imageInfo.digest)
  const href = reportId
    ? `/topmost-owners/${workloadUid}/images/${digest}?report=${reportId}`
    : `/topmost-owners/${workloadUid}/images/${digest}`

  return (
    <PrefetchLink href={href} className={rowClass}>
      {inner}
    </PrefetchLink>
  )
}

export default function ContainersCard({ usages, reportId }: { usages: ImageUsage[]; reportId: string | null }) {
  const entries = collectContainers(usages)
  if (entries.length === 0) return null

  const repoCount = new Set(entries.map(e => e.repoKey)).size
  const repoLabel = repoCount === 1 ? "1 image repo" : `${repoCount} image repos`
  const containerLabel = entries.length === 1 ? "1 container" : `${entries.length} containers`

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Containers
      </p>
      <div className="rounded-xl border border-gray-200 bg-white">
        <div className="flex items-center justify-between gap-4 border-b border-gray-100 px-4 py-3">
          <p className="text-xs text-muted-foreground">What this chart ships</p>
          <p className="shrink-0 text-xs text-foreground">
            {containerLabel} <span className="text-muted-foreground">· {repoLabel}</span>
          </p>
        </div>
        {entries.map((entry, i) => (
          <ContainerRow key={`${entry.containerName}|${entry.imageLabel}`} entry={entry} reportId={reportId} first={i === 0} />
        ))}
      </div>
    </div>
  )
}
