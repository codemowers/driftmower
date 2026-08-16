"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { StatusType } from "@/lib/cluster/reports"
import type { Span } from "@/lib/cluster/drift-history/types"
import { SEVERITY_STYLE, isNoData } from "@/lib/cluster/status-style"
import { parseFilterTokens, statusesFromTokens, statusTokens } from "@/lib/utils/filter-params"
import { imagePath } from "@/lib/utils/image-artifacts"
import { useContextHref, type LinkTo } from "@/lib/hooks/use-context-href"
import {
  CVE_SEVERITY_STYLE,
  compareVulnerabilities,
  worstVulnerability,
  type Vulnerability,
  type VulnerabilityReport,
} from "@/lib/cluster/vulnerability"
import DriftSparkline from "@/app/components/drift-history/drift-sparkline"
import { useImageHistory } from "@/lib/hooks/use-bulk-drift-history"
import ImageFilters from "./image-filters"
import type { ImageEntry } from "../utils/image-entries"

const GRID = "grid-cols-[3.5fr_2fr_2fr_1.9fr_0.9fr_1.2fr]"
const HEADERS = ["Image", "Running", "Used by", "Historic drift", "Drift", "Worst CVE"]

function WorstCveCell({
  digests,
  reports,
}: {
  digests: string[]
  reports: Record<string, VulnerabilityReport> | null
}) {
  if (reports === null) {
    return <span className="text-xs text-muted-foreground">—</span>
  }

  const scanned = digests.map(d => reports[d]).filter(Boolean)
  if (scanned.length === 0) {
    return (
      <span className="rounded-md bg-gray-100 px-2 py-1.5 text-xs font-semibold text-muted-foreground">
        No scan
      </span>
    )
  }

  const worst = scanned
    .map(worstVulnerability)
    .filter((v): v is Vulnerability => v !== null)
    .sort(compareVulnerabilities)[0]

  const style = worst ? CVE_SEVERITY_STYLE[worst.severity] : undefined
  if (!worst || !style) {
    return (
      <span className="rounded-md bg-status-ok-bg px-2 py-1.5 text-xs font-semibold text-status-ok-label">
        Clean
      </span>
    )
  }

  return (
    <span className={cn("rounded-md px-2 py-1.5 text-xs font-semibold whitespace-nowrap", style.bg, style.text)}>
      {style.label}{worst.score > 0 && ` ${worst.score}`}
    </span>
  )
}

function runningLabel({ versionCount, runningTags }: ImageEntry): string {
  return versionCount > 1 ? `${versionCount} versions` : runningTags[0] ?? "—"
}

function UsedByCell({ entry }: { entry: ImageEntry }) {
  const { workloads, containerCount } = entry
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate text-sm text-foreground">
        {workloads.length === 0
          ? "—"
          : workloads.length === 1
            ? workloads[0].name
            : `${workloads.length} workloads`}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">
        {containerCount} {containerCount === 1 ? "container" : "containers"}
      </span>
    </div>
  )
}

function ImageRow({
  entry,
  reports,
  spans,
  linkTo,
}: {
  entry: ImageEntry
  reports: Record<string, VulnerabilityReport> | null
  spans: Span[] | undefined
  linkTo: LinkTo
}) {
  const { registry, repository, latestTag, worstStatus, issueCount, digests } = entry
  const style = SEVERITY_STYLE[worstStatus]
  const path = imagePath(entry.key)

  return (
    <Link
      href={linkTo(`/container-images/${path}`, { drop: ["focus"] })}
      className={cn("grid items-center gap-4 pl-6 pr-4 py-4 hover:bg-brand-bg/40 transition-colors", GRID)}
    >
      {/* Image */}
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-semibold text-foreground">{repository}</span>
          {issueCount > 0 && (
            <span className="flex items-center gap-1 shrink-0 rounded-md bg-status-minor-bg px-1.5 py-0.5 text-status-minor-label">
              <AlertTriangle className="size-3" />
              <span className="text-xs font-medium tabular-nums">{issueCount}</span>
            </span>
          )}
        </div>
        <span className="truncate font-mono text-xs text-muted-foreground">{registry}</span>
      </div>

      {/* Running */}
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-mono text-sm text-foreground">{runningLabel(entry)}</span>
        {latestTag && (
          <span className="truncate font-mono text-xs text-muted-foreground">latest {latestTag}</span>
        )}
      </div>

      <UsedByCell entry={entry} />

      <div className="flex items-center pr-10">
        {spans ? <DriftSparkline spans={spans} className="w-full" /> : <span className="text-xs text-muted-foreground">—</span>}
      </div>

      {/* Drift */}
      <div className="flex items-center">
        {style ? (
          <span className={cn("text-center rounded-md px-3 py-1.5 text-xs font-semibold", style.bg, style.text)}>
            {style.label}
          </span>
        ) : (
          <span className="text-center rounded-md bg-gray-100 px-3 py-1.5 text-xs font-semibold text-muted-foreground">
            No data
          </span>
        )}
      </div>

      {/* Worst CVE */}
      <div>
        <WorstCveCell digests={digests} reports={reports} />
      </div>
    </Link>
  )
}

export default function ImageList({ entries }: { entries: ImageEntry[] }) {
  const reports = useClusterState(s => s.vulnerabilityReports)
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
            <ImageRow key={entry.key} entry={entry} reports={reports} spans={history[entry.key]?.spans} linkTo={linkTo} />
          ))
        ) : (
          <p className="py-12 text-center text-sm text-muted-foreground">No images match your filters</p>
        )}
      </div>
    </div>
  )
}
