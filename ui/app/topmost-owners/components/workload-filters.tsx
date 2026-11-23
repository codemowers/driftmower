"use client"

import { ISSUE_STYLE, type IssueSeverity } from "@/lib/cluster/issues"
import { SlidersHorizontal } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  FilterSearchInput,
  FilterChips,
  FilterFooter,
  FilterToggle,
  FILTER_ACTIVE,
  FILTER_INACTIVE,
} from "@/app/components/filter-bar"

type Props = {
  total: number
  filtered: number
  isModified: boolean
  searchQuery: string
  onSearchChange: (q: string) => void
  chips: { token: string; label: string }[]
  issueChips: { token: string; label: string; severity: IssueSeverity; count: number }[]
  activeTokens: Set<string>
  onTokenToggle: (token: string) => void
  showDownscaled: boolean
  onToggleDownscaled: () => void
  showFinished: boolean
  onToggleFinished: () => void
  hideHelmManaged: boolean
  onToggleHelmManaged: () => void
  hideArgoManaged: boolean
  onToggleArgoManaged: () => void
  hideOrphaned: boolean
  onToggleOrphaned: () => void
  counts: { downscaled: number; finished: number; helm: number; argo: number; orphaned: number }
  onReset: () => void
}

export default function WorkloadFilters({
  total, filtered, isModified,
  searchQuery, onSearchChange,
  chips, issueChips, activeTokens, onTokenToggle,
  showFinished, onToggleFinished,
  showDownscaled, onToggleDownscaled,
  hideHelmManaged, onToggleHelmManaged,
  hideArgoManaged, onToggleArgoManaged,
  hideOrphaned, onToggleOrphaned,
  counts, onReset,
}: Props) {
  const menuFilterCount = (showFinished ? 1 : 0) + (showDownscaled ? 1 : 0) + (hideHelmManaged ? 1 : 0) + (hideArgoManaged ? 1 : 0) + (hideOrphaned ? 1 : 0)

  return (
    <div className="border-b border-gray-200 px-5 py-3.5">
      <div className="flex items-center gap-7">
        <FilterSearchInput
          value={searchQuery}
          onChange={onSearchChange}
          placeholder="Search workloads, namespaces, managers, images..."
        />

        <div className="flex items-center gap-2">
          <FilterChips chips={chips} active={activeTokens} onToggle={onTokenToggle} />

          <div className="mx-1 h-5 w-px bg-gray-200" />

          <Popover>
            <PopoverTrigger
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold transition-colors",
                menuFilterCount > 0 ? FILTER_ACTIVE : FILTER_INACTIVE,
              )}
            >
              <SlidersHorizontal className="size-3.5" />
              Filters
              {menuFilterCount > 0 && (
                <span className="flex size-4 items-center justify-center rounded-full bg-brand text-[10px] font-bold text-white tabular-nums">
                  {menuFilterCount}
                </span>
              )}
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 gap-0.5 p-2">
              <FilterToggle checked={showFinished} onToggle={onToggleFinished} label="Show finished workloads" count={counts.finished} />
              <FilterToggle checked={showDownscaled} onToggle={onToggleDownscaled} label="Show downscaled" count={counts.downscaled} />
              <FilterToggle checked={hideHelmManaged} onToggle={onToggleHelmManaged} label="Hide Helm-managed" count={counts.helm} />
              <FilterToggle checked={hideArgoManaged} onToggle={onToggleArgoManaged} label="Hide ArgoCD-managed" count={counts.argo} />
              <FilterToggle checked={hideOrphaned} onToggle={onToggleOrphaned} label="Hide orphaned" count={counts.orphaned} />
            </PopoverContent>
          </Popover>
        </div>

        <FilterFooter filtered={filtered} total={total} isModified={isModified} onReset={onReset} />
      </div>
      {issueChips.length > 0 && <div aria-label="Reported issues" className="mt-3 flex flex-wrap items-center gap-2">
        {issueChips.map(({ token, label, severity, count }) => <button
          key={token} type="button" aria-pressed={activeTokens.has(token)} onClick={() => onTokenToggle(token)}
          title={`${count} affected ${count === 1 ? "workload" : "workloads"}; ${severity}`}
          className={cn("rounded-md px-2.5 py-1 text-xs font-semibold transition-colors", ISSUE_STYLE[severity].bg, ISSUE_STYLE[severity].text,
            activeTokens.has(token) ? "ring-2 ring-current" : "hover:ring-1 hover:ring-current")}>
          {label} <span className="ml-1 tabular-nums">{count}</span>
        </button>)}
      </div>}
    </div>
  )
}
