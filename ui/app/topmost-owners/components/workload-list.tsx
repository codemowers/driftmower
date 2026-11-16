"use client"

import { useEffect, useMemo, useState } from "react"
import PrefetchLink, { usePagePrefetch } from "@/app/components/prefetch-link"
import { useRouter, useSearchParams } from "next/navigation"
import { ExternalLink, Layers } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { parseFilterTokens } from "@/lib/utils/filter-params"
import { useContextHref, type LinkTo } from "@/lib/hooks/use-context-href"
import WorkloadFilters from "./workload-filters"
import { isFinished, isDownscaled } from "../workload-lifecycle"
import type { FocusDefinition, WorkloadEntry } from "../focus/types"

export type { WorkloadEntry } from "../focus/types"


function matchesIdentity(e: WorkloadEntry, q: string): boolean {
  return (
    e.name.toLowerCase().includes(q) ||
    e.namespace.toLowerCase().includes(q) ||
    (e.manager.kind !== "standalone" && e.manager.name.toLowerCase().includes(q))
  )
}

function matchingRepos(e: WorkloadEntry, q: string): string[] {
  return e.repos.filter(r => r.toLowerCase().includes(q)).sort()
}

function WorkloadRow({
  entry,
  focus,
  reportId,
  linkTo,
  repoHint,
}: {
  entry: WorkloadEntry
  focus: FocusDefinition
  reportId: string | null
  linkTo: LinkTo
  repoHint: string[]
}) {
  const router = useRouter()
  const prefetchPage = usePagePrefetch()
  const { uid, kind, name, namespace, manager } = entry

  const managerLinkable = (manager.kind === "helm" && !!manager.uid) || (manager.kind === "argo" && !!manager.url)

  const releaseHref = manager.kind === "helm" && manager.uid
    ? (reportId ? `/helm-releases/${manager.uid}?report=${reportId}` : `/helm-releases/${manager.uid}`)
    : null

  function prefetchManager() {
    if (releaseHref) prefetchPage(releaseHref)
  }

  function openManager(e: React.MouseEvent | React.KeyboardEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (releaseHref) {
      router.push(releaseHref)
    } else if (manager.kind === "argo" && manager.url) {
      window.open(manager.url, "_blank", "noopener")
    }
  }

  const href = linkTo(`/topmost-owners/${uid}`, { drop: ["wtab"] })

  const cells = (
    <>
      {/* Kind */}
      <div className="self-start text-right">
        <span className={cn("rounded-md px-2.5 py-1 text-xs font-semibold", entry.orphan ? "bg-status-minor-bg text-status-minor-label" : "bg-brand-bg text-brand-label")}>
          {kind}
        </span>
      </div>

      {/* Workload */}
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-foreground truncate">{name}</span>
        </div>
        <span className="font-mono text-xs text-muted-foreground">{namespace}</span>
        {repoHint.length > 0 && (
          <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <Layers className="size-3 shrink-0" />
            <span className="truncate font-mono">{repoHint[0]}</span>
            {repoHint.length > 1 && (
              <span className="shrink-0 tabular-nums">+{repoHint.length - 1}</span>
            )}
          </div>
        )}
      </div>

      {/* Manager */}
      <div className="min-w-0">
        {entry.orphan ? (
          <span className="font-mono text-sm text-status-minor-label">Orphaned</span>
        ) : manager.kind === "standalone" ? (
          <span className="font-mono text-sm text-muted-foreground">Standalone</span>
        ) : managerLinkable ? (
          <span
            role="link"
            tabIndex={0}
            onClick={openManager}
            onMouseEnter={prefetchManager}
            onFocus={prefetchManager}
            onKeyDown={(e) => { if (e.key === "Enter") openManager(e) }}
            className="group inline-flex items-center gap-1.5 max-w-full text-sm text-foreground hover:text-brand-text hover:underline cursor-pointer"
          >
            <span className="font-mono truncate">{manager.name}</span>
            <ExternalLink className="size-3.5 shrink-0 text-muted-foreground group-hover:text-brand-text" />
          </span>
        ) : (
          <span className="font-mono text-sm text-foreground truncate">{manager.name}</span>
        )}
      </div>

      {entry.orphan === "bucket"
        ? <span className="col-span-3 text-sm text-muted-foreground">{entry.orphanSummary}</span>
        : focus.renderCells(entry)}
    </>
  )

  return (
    <PrefetchLink
      href={href}
      className={cn("grid items-center gap-4 pl-6 pr-4 py-4 transition-colors", entry.orphan ? "bg-status-minor-bg/30 hover:bg-status-minor-bg/50" : "hover:bg-brand-bg/40", focus.gridCols)}
    >
      {cells}
    </PrefetchLink>
  )
}

export default function WorkloadList({
  entries,
  focus,
  syncUrl,
}: {
  entries: WorkloadEntry[]
  focus: FocusDefinition
  syncUrl: boolean
}) {
  const reportId = useClusterState(s => s.reportId)
  const router = useRouter()
  const searchParams = useSearchParams()
  const { linkTo } = useContextHref()
  const initialTokens = parseFilterTokens(searchParams.get("filters"))
  const [activeTokens, setActiveTokens] = useState<Set<string>>(
    () => new Set([...initialTokens].filter(t => focus.scale.some(l => l.token === t))),
  )
  const [showDownscaled, setShowDownscaled] = useState(() => initialTokens.has("showdownscaled"))
  const [showFinished, setShowFinished] = useState(() => initialTokens.has("showfinished"))
  const [hideHelmManaged, setHideHelmManaged] = useState(() => initialTokens.has("hidehelm"))
  const [hideArgoManaged, setHideArgoManaged] = useState(() => initialTokens.has("hideargo"))
  const [hideOrphaned, setHideOrphaned] = useState(() => initialTokens.has("hideorphaned"))
  const [searchQuery, setSearchQuery] = useState(() => searchParams.get("q") ?? "")

  useEffect(() => {
    if (!syncUrl) return
    const filters = [
      ...focus.scale.filter(l => activeTokens.has(l.token)).map(l => l.token),
      ...(showFinished ? ["showfinished"] : []),
      ...(showDownscaled ? ["showdownscaled"] : []),
      ...(hideHelmManaged ? ["hidehelm"] : []),
      ...(hideArgoManaged ? ["hideargo"] : []),
      ...(hideOrphaned ? ["hideorphaned"] : []),
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
  }, [syncUrl, activeTokens, showFinished, showDownscaled, hideHelmManaged, hideArgoManaged, hideOrphaned, searchQuery, searchParams, router, focus])

  function handleTokenToggle(token: string) {
    setActiveTokens(prev => {
      const next = new Set(prev)
      if (next.has(token)) next.delete(token)
      else next.add(token)
      return next
    })
  }

  function handleReset() {
    setActiveTokens(new Set())
    setShowFinished(false)
    setShowDownscaled(false)
    setHideHelmManaged(false)
    setHideArgoManaged(false)
    setHideOrphaned(false)
    setSearchQuery("")
  }

  const counts = useMemo(() => ({
    finished: entries.filter(isFinished).length,
    downscaled: entries.filter(isDownscaled).length,
    helm: entries.filter(e => e.manager.kind === "helm").length,
    argo: entries.filter(e => e.manager.kind === "argo").length,
    orphaned: entries.filter(e => e.orphan).length,
  }), [entries])

  const isModified =
    activeTokens.size > 0 || searchQuery !== "" || showFinished || showDownscaled || hideHelmManaged || hideArgoManaged || hideOrphaned

  const sortedEntries = useMemo(() => [...entries].sort(focus.compare), [entries, focus])

  const activeScale = focus.scale.filter(l => activeTokens.has(l.token))
  const q = searchQuery.toLowerCase()
  const filteredEntries = sortedEntries
    .filter(e => activeScale.length === 0 || activeScale.some(l => l.match(e)))
    .filter(e => showFinished || !isFinished(e))
    .filter(e => showDownscaled || !isDownscaled(e))
    .filter(e => !hideHelmManaged || e.manager.kind !== "helm")
    .filter(e => !hideArgoManaged || e.manager.kind !== "argo")
    .filter(e => !hideOrphaned || !e.orphan)
    .filter(e => q === "" || matchesIdentity(e, q) || matchingRepos(e, q).length > 0)

  if (q !== "") {
    filteredEntries.sort((a, b) => Number(matchesIdentity(b, q)) - Number(matchesIdentity(a, q)))
  }

  return (
    <div className="flex flex-col rounded-xl border border-gray-200 bg-white">
      <WorkloadFilters
        total={entries.length}
        filtered={filteredEntries.length}
        isModified={isModified}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        chips={focus.scale}
        activeTokens={activeTokens}
        onTokenToggle={handleTokenToggle}
        showDownscaled={showDownscaled}
        onToggleDownscaled={() => setShowDownscaled(v => !v)}
        showFinished={showFinished}
        onToggleFinished={() => setShowFinished(v => !v)}
        hideHelmManaged={hideHelmManaged}
        onToggleHelmManaged={() => setHideHelmManaged(v => !v)}
        hideArgoManaged={hideArgoManaged}
        onToggleArgoManaged={() => setHideArgoManaged(v => !v)}
        hideOrphaned={hideOrphaned}
        onToggleOrphaned={() => setHideOrphaned(v => !v)}
        counts={counts}
        onReset={handleReset}
      />
      <header className={cn("grid gap-4 border-b border-gray-100 pl-6 pr-4 py-4", focus.gridCols)}>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground text-right">Kind</p>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Workload</p>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Manager</p>
        {focus.headers.map(header => (
          <p key={header} className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{header}</p>
        ))}
      </header>
      <div className="divide-y divide-gray-100">
        {filteredEntries.length > 0 ? (
          filteredEntries.map(entry => (
            <WorkloadRow
              key={entry.groupKey}
              entry={entry}
              focus={focus}
              reportId={reportId}
              linkTo={linkTo}
              repoHint={q !== "" && !matchesIdentity(entry, q) ? matchingRepos(entry, q) : []}
            />
          ))
        ) : (
          <p className="py-12 text-center text-sm text-muted-foreground">No workloads match your filters</p>
        )}
      </div>
    </div>
  )
}
