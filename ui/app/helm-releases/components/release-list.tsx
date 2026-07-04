"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import type { ReleaseInfo, StatusType } from "@/lib/cluster/reports"
import { parseFilterTokens, statusesFromTokens, statusTokens } from "@/lib/utils/filter-params"
import { SEVERITY_STYLE } from "@/lib/cluster/status-style"
import { useContextHref, type LinkTo } from "@/lib/hooks/use-context-href"
import ReleaseFilters from "./release-filters"

export type ReleaseEntry = {
  groupKey: string
  releaseInfo: ReleaseInfo
  normalizedScore: number
  staleRepoCount: number
  distinctRepoCount: number
  totalContainers: number
  totalWorkloadCount: number
  worstStatus: StatusType
  issueCount: number
}

function staleColor(staleRepoCount: number, distinctRepoCount: number): string {
  if (staleRepoCount === 0) return "text-muted-foreground"
  if (staleRepoCount === distinctRepoCount) return "text-status-major-label"
  return "text-status-minor-label"
}

function ReleaseItem({ entry, linkTo }: { entry: ReleaseEntry; linkTo: LinkTo }) {
  const { releaseInfo, staleRepoCount, distinctRepoCount, totalContainers, totalWorkloadCount, worstStatus, issueCount } = entry
  const style = SEVERITY_STYLE[worstStatus]
  const showAppVersion = releaseInfo.chartAppVersion && releaseInfo.chartAppVersion !== releaseInfo.chartVersion
  const href = linkTo(`/helm-releases/${releaseInfo.uid}`, { drop: ["htab"] })

  return (
    <Link
      href={href}
      className="grid grid-cols-[2.5fr_3fr_1fr_1fr_1fr] gap-4 pl-6 pr-4 py-4 items-center hover:bg-brand-bg/40 transition-colors"
    >
      {/* Release */}
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-foreground truncate">{releaseInfo.name}</span>
          {issueCount > 0 && (
            <span className="flex items-center gap-1 shrink-0 rounded-md bg-status-minor-bg px-1.5 py-0.5 text-status-minor-label">
              <AlertTriangle className="size-3" />
              <span className="text-xs font-medium tabular-nums">{issueCount}</span>
            </span>
          )}
        </div>
        <span className="font-mono text-xs text-muted-foreground">{releaseInfo.namespace}</span>
      </div>

      {/* Chart */}
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-mono text-sm text-foreground truncate">{releaseInfo.chartName}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {releaseInfo.chartVersion}
          {showAppVersion && ` · app ${releaseInfo.chartAppVersion}`}
        </span>
      </div>

      {/* Contents */}
      <div className="flex flex-col gap-0.5">
        <span className="text-sm text-foreground tabular-nums">{totalContainers} {totalContainers === 1 ? "container" : "containers"}</span>
        <span className="text-xs text-muted-foreground tabular-nums">{totalWorkloadCount} {totalWorkloadCount === 1 ? "workload" : "workloads"}</span>
      </div>

      {/* Stale repos */}
      <div>
        <span className={cn("text-sm tabular-nums font-medium", staleColor(staleRepoCount, distinctRepoCount))}>
          {staleRepoCount}/{distinctRepoCount}
        </span>
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
    </Link>
  )
}

export default function ReleaseList({ entries }: { entries: ReleaseEntry[] }) {
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
      if (next.has(status)) {
        next.delete(status)
      } else {
        next.add(status)
      }
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
      if (activeStatuses.has("no_data") && (e.worstStatus === "no_data" || e.worstStatus === "no_version")) return true
      return activeStatuses.has(e.worstStatus)
    })
    .filter(e => !showIssuesOnly || e.issueCount > 0)
    .filter(e =>
      q === "" ||
      e.releaseInfo.name.toLowerCase().includes(q) ||
      e.releaseInfo.namespace?.toLowerCase().includes(q) ||
      e.releaseInfo.chartName?.toLowerCase().includes(q)
    )

  return (
    <div className="flex flex-col rounded-xl border border-gray-200 bg-white">
      <ReleaseFilters
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
      <header className="grid grid-cols-[2.5fr_3fr_1fr_1fr_1fr] gap-4 border-b border-gray-100 pl-6 pr-4 py-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Release</p>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Chart</p>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Contents</p>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Stale repos</p>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Drift</p>
      </header>
      <div className="divide-y divide-gray-100">
        {filteredEntries.length > 0 ? (
          filteredEntries.map(entry => (
            <ReleaseItem key={entry.groupKey} entry={entry} linkTo={linkTo} />
          ))
        ) : (
          <p className="py-12 text-center text-sm text-muted-foreground">No releases match your filters</p>
        )}
      </div>
    </div>
  )
}
