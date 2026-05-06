"use client"

import { useState } from "react"
import Link from "next/link"
import { AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { ReleaseInfo, StatusType } from "@/lib/cluster/reports"
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

const SEVERITY_STYLE: Partial<Record<StatusType, { bg: string; text: string; label: string }>> = {
  major_behind: { bg: "bg-status-major-bg", text: "text-status-major-label", label: "Major" },
  minor_behind:  { bg: "bg-status-minor-bg", text: "text-status-minor-label", label: "Minor" },
  patch_behind:  { bg: "bg-status-patch-bg", text: "text-status-patch-label", label: "Patch" },
  up_to_date:    { bg: "bg-status-ok-bg",    text: "text-status-ok-label",    label: "OK" },
}

function staleColor(staleRepoCount: number, distinctRepoCount: number): string {
  if (staleRepoCount === 0) return "text-muted-foreground"
  if (staleRepoCount === distinctRepoCount) return "text-status-major-label"
  return "text-status-minor-label"
}

function ReleaseItem({ entry, reportId }: { entry: ReleaseEntry; reportId: string | null }) {
  const { releaseInfo, staleRepoCount, distinctRepoCount, totalContainers, totalWorkloadCount, worstStatus, issueCount } = entry
  const style = SEVERITY_STYLE[worstStatus]
  const showAppVersion = releaseInfo.chartAppVersion && releaseInfo.chartAppVersion !== releaseInfo.chartVersion
  const href = reportId
    ? `/helm-releases/${releaseInfo.uid}?report=${reportId}`
    : `/helm-releases/${releaseInfo.uid}`

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
  const reportId = useClusterState(state => state.reportId)
  const [activeStatuses, setActiveStatuses] = useState<Set<StatusType>>(new Set())
  const [showIssuesOnly, setShowIssuesOnly] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")

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
            <ReleaseItem key={entry.groupKey} entry={entry} reportId={reportId} />
          ))
        ) : (
          <p className="py-12 text-center text-sm text-muted-foreground">No releases match your filters</p>
        )}
      </div>
    </div>
  )
}
