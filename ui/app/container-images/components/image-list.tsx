"use client"

import { useEffect, useState } from "react"
import PrefetchLink from "@/app/components/prefetch-link"
import { useRouter, useSearchParams } from "next/navigation"
import { AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import type { StatusType } from "@/lib/cluster/reports"
import type { Span } from "@/lib/features/drift-history/types"
import { isNoData } from "@/lib/cluster/styles/status-style"
import { parseFilterTokens, statusesFromTokens, statusTokens } from "@/lib/utils/filter-params"
import { imagePath } from "@/lib/utils/image-artifacts"
import { useContextHref, type LinkTo } from "@/lib/hooks/use-context-href"
import DriftSparkline from "@/app/components/drift-history/drift-sparkline"
import { useImageHistory } from "@/lib/features/drift-history/use-bulk-drift-history"
import ImageFilters from "./image-filters"
import type { ImageEntry } from "../utils/image-entries"
import ScanStatusBadge,{useImageScanStatuses} from "./scan-status"
import { sourceRepositoryPath } from "@/lib/features/crawler/sources"
import type {ScanStatus} from "@/lib/features/images/scan-status"

const GRID = "grid-cols-[3fr_2.5fr_1.8fr_1.8fr_1.4fr_1.9fr]"
const HEADERS = ["Image", "Source", "Running", "Used by", "Trivy scan", "Historic drift"]

function safeSourceUrl(raw: string | null) {
  try {
    const url = new URL(raw ?? "")
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href.replace(/\/$/, "") : null
  } catch { return null }
}

function runningLabel({ versionCount, runningTags }: ImageEntry): string {
  return versionCount > 1 ? `${versionCount} versions` : runningTags[0] ?? "—"
}

function UsedByCell({ entry, linkTo }: { entry: ImageEntry; linkTo: LinkTo }) {
  const { workloads } = entry
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {workloads.slice(0, 3).map(workload => <PrefetchLink key={workload.uid} href={linkTo(`/topmost-owners/${workload.uid}`)} className="relative z-10 truncate text-xs text-brand-text hover:underline">{workload.namespace}/{workload.name}</PrefetchLink>)}
      {!workloads.length && <span className="text-xs text-muted-foreground">—</span>}
      {workloads.length > 3 && <span className="text-xs text-muted-foreground">+{workloads.length - 3} more</span>}

    </div>
  )
}

function ImageRow({
  entry,
  spans,
  linkTo,
  scanStatuses,scanError,scanLoading,
}: {
  entry: ImageEntry
  spans: Span[] | undefined
  linkTo: LinkTo
  scanStatuses?:Record<string,ScanStatus>
  scanError?:string
  scanLoading:boolean
}) {
  const { registry, repository, latestTag, issueCount, sourceUrl } = entry
  const path = imagePath(entry.key)
  const source = safeSourceUrl(sourceUrl)

  // The row links to the image; the source link sits above that link.
  return (
    <div className={cn("relative grid items-center gap-4 pl-6 pr-4 py-4 hover:bg-brand-bg/40 transition-colors", GRID)}>
      {/* Image */}
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <PrefetchLink href={linkTo(`/container-images/${path}`, { drop: ["focus"] })} className="truncate font-semibold text-foreground after:absolute after:inset-0">{repository}</PrefetchLink>
          {issueCount > 0 && (
            <span className="flex items-center gap-1 shrink-0 rounded-md bg-status-minor-bg px-1.5 py-0.5 text-status-minor-label">
              <AlertTriangle className="size-3" />
              <span className="text-xs font-medium tabular-nums">{issueCount}</span>
            </span>
          )}
        </div>
        <span className="truncate font-mono text-xs text-muted-foreground">{registry}</span>
      </div>

      <div className="min-w-0">
        {source
          ? <PrefetchLink href={linkTo(sourceRepositoryPath(source))} title={source} className="relative z-10 inline-flex max-w-full items-center gap-1 font-mono text-xs text-brand-text hover:underline">
              <span className="truncate">{source.replace(/^https?:\/\//, "")}</span>
            </PrefetchLink>
          : <span className="text-xs text-muted-foreground">—</span>}
      </div>

      {/* Running */}
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-mono text-sm text-foreground">{runningLabel(entry)}</span>
        {latestTag && (
          <span className="truncate font-mono text-xs text-muted-foreground">latest {latestTag}</span>
        )}
      </div>

      <UsedByCell entry={entry} linkTo={linkTo} />
      <ScanStatusBadge digests={entry.digests} statuses={scanStatuses} error={scanError} loading={scanLoading}/>

      <div className="flex items-center pr-10">
        {spans ? <DriftSparkline spans={spans} className="w-full" /> : <span className="text-xs text-muted-foreground">—</span>}
      </div>

    </div>
  )
}

export default function ImageList({ entries }: { entries: ImageEntry[] }) {
  const history = useImageHistory()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { linkTo } = useContextHref()
  const initialTokens = parseFilterTokens(searchParams.get("filters"))
  const [activeStatuses, setActiveStatuses] = useState<Set<StatusType>>(() => statusesFromTokens(initialTokens))
  const [showIssuesOnly, setShowIssuesOnly] = useState(() => initialTokens.has("issues"))
  const [searchQuery, setSearchQuery] = useState(() => searchParams.get("q") ?? "")

  useEffect(() => {
    const filters = [
      ...statusTokens(activeStatuses),
      ...(showIssuesOnly ? ["issues"] : []),
    ].join(",")
    const params = new URLSearchParams(searchParams.toString())
    if (filters) params.set("filters", filters)
    else params.delete("filters")
    if (searchQuery) params.set("q", searchQuery)
    else params.delete("q")
    const next = params.toString()
    if (next !== searchParams.toString()) {
      router.replace(next ? `?${next}` : window.location.pathname)
    }
  }, [activeStatuses, showIssuesOnly, searchQuery, searchParams, router])

  function handleStatusToggle(status: StatusType) {
    setActiveStatuses(prev => {
      const next = new Set(prev)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return next
    })
  }

  function handleClear() {
    setActiveStatuses(new Set())
    setShowIssuesOnly(false)
    setSearchQuery("")
  }

  const isFiltered = activeStatuses.size > 0 || showIssuesOnly || searchQuery !== ""

  const q = searchQuery.toLowerCase()
  const filteredEntries = entries
    .filter(e => {
      if (activeStatuses.size === 0) return true
      if (activeStatuses.has("no_data") && isNoData(e.worstStatus)) return true
      return activeStatuses.has(e.worstStatus)
    })
    .filter(e => !showIssuesOnly || e.issueCount > 0)
    .filter(e =>
      q === "" ||
      e.repository.toLowerCase().includes(q) ||
      e.registry.toLowerCase().includes(q) ||
      e.runningTags.some(t => t.toLowerCase().includes(q)) ||
      (e.latestTag?.toLowerCase().includes(q) ?? false)
    )

  const scans=useImageScanStatuses(filteredEntries.flatMap(entry=>entry.digests))

  return (
    <div className="flex flex-col rounded-xl border border-gray-200 bg-white">
      <ImageFilters
        total={entries.length}
        filtered={filteredEntries.length}
        isFiltered={isFiltered}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        activeStatuses={activeStatuses}
        onStatusToggle={handleStatusToggle}
        showIssuesOnly={showIssuesOnly}
        onIssuesToggle={() => setShowIssuesOnly(v => !v)}
        onClear={handleClear}
      />
      <header className={cn("grid gap-4 border-b border-gray-100 pl-6 pr-4 py-4", GRID)}>
        {HEADERS.map(header => (
          <p key={header} className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {header}
          </p>
        ))}
      </header>
      <div className="divide-y divide-gray-100">
        {filteredEntries.length > 0 ? (
          filteredEntries.map(entry => (
            <ImageRow key={entry.key} entry={entry} spans={history[entry.key]?.spans} linkTo={linkTo} scanStatuses={scans.data} scanError={scans.error} scanLoading={scans.loading}/>
          ))
        ) : (
          <p className="py-12 text-center text-sm text-muted-foreground">No images match your filters</p>
        )}
      </div>
    </div>
  )
}
