"use client"

import { useState } from "react"
import Link from "next/link"
import { AlertTriangle, ExternalLink } from "lucide-react"
import { cn } from "@/lib/utils"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { StatusType } from "@/lib/cluster/reports"
import WorkloadFilters from "./workload-filters"

export type WorkloadEntry = {
  groupKey: string
  kind: string
  name: string
  namespace: string
  manager: { kind: "helm"; name: string; uid: string } | { kind: "standalone" }
  containerCount: number
  staleRepoCount: number
  distinctRepoCount: number
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

const GRID = "grid-cols-[95px_3fr_2fr_1fr_0.9fr_1fr]"

function WorkloadRow({ entry, reportId }: { entry: WorkloadEntry; reportId: string | null }) {
  const { kind, name, namespace, manager, containerCount, staleRepoCount, distinctRepoCount, worstStatus, issueCount } = entry
  const style = SEVERITY_STYLE[worstStatus]

  const managerHref = manager.kind === "helm"
    ? (reportId ? `/helm-releases/${manager.uid}?report=${reportId}` : `/helm-releases/${manager.uid}`)
    : null

  return (
    <div className={cn("grid items-center gap-4 pl-6 pr-4 py-4", GRID)}>
      {/* Kind */}
      <div className="self-start text-right">
        <span className="rounded-md bg-brand-bg px-2.5 py-1 text-xs font-semibold text-brand-label">
          {kind}
        </span>
      </div>

      {/* Workload */}
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-foreground truncate">{name}</span>
          {issueCount > 0 && (
            <span className="flex items-center gap-1 shrink-0 rounded-md bg-status-minor-bg px-1.5 py-0.5 text-status-minor-label">
              <AlertTriangle className="size-3" />
              <span className="text-xs font-medium tabular-nums">{issueCount}</span>
            </span>
          )}
        </div>
        <span className="font-mono text-xs text-muted-foreground">{namespace}</span>
      </div>

      {/* Manager */}
      <div className="min-w-0">
        {managerHref ? (
          <Link href={managerHref} className="group inline-flex items-center gap-1.5 max-w-full text-sm text-foreground hover:text-brand-text hover:underline">
            <span className="font-mono truncate">{manager.kind === "helm" ? manager.name : ""}</span>
            <ExternalLink className="size-3.5 shrink-0 text-muted-foreground group-hover:text-brand-text" />
          </Link>
        ) : (
          <span className="font-mono text-sm text-muted-foreground">Standalone</span>
        )}
      </div>

      {/* Contents */}
      <div>
        <span className="text-sm tabular-nums text-foreground">{containerCount} {containerCount === 1 ? "container" : "containers"}</span>
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
    </div>
  )
}

export default function WorkloadList({ entries }: { entries: WorkloadEntry[] }) {
  const reportId = useClusterState(s => s.reportId)
  const [activeStatuses, setActiveStatuses] = useState<Set<StatusType>>(new Set())
  const [showIssuesOnly, setShowIssuesOnly] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")

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
      if (activeStatuses.has("no_data") && (e.worstStatus === "no_data" || e.worstStatus === "no_version")) return true
      return activeStatuses.has(e.worstStatus)
    })
    .filter(e => !showIssuesOnly || e.issueCount > 0)
    .filter(e =>
      q === "" ||
      e.name.toLowerCase().includes(q) ||
      e.namespace.toLowerCase().includes(q) ||
      (e.manager.kind === "helm" && e.manager.name.toLowerCase().includes(q))
    )

  return (
    <div className="flex flex-col rounded-xl border border-gray-200 bg-white">
      <WorkloadFilters
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
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground text-right">Kind</p>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Workload</p>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Manager</p>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Contents</p>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Stale repos</p>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Drift</p>
      </header>
      <div className="divide-y divide-gray-100">
        {filteredEntries.length > 0 ? (
          filteredEntries.map(entry => (
            <WorkloadRow key={entry.groupKey} entry={entry} reportId={reportId} />
          ))
        ) : (
          <p className="py-12 text-center text-sm text-muted-foreground">No workloads match your filters</p>
        )}
      </div>
    </div>
  )
}
