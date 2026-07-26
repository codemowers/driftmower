"use client"

import { SlidersHorizontal } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import { Checkbox } from "@/components/ui/checkbox"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  FilterSearchInput,
  FilterChips,
  FilterFooter,
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
  activeTokens: Set<string>
  onTokenToggle: (token: string) => void
  showIssuesOnly: boolean
  onIssuesToggle: () => void
  showFinished: boolean
  onToggleFinished: () => void
  hideHelmManaged: boolean
  onToggleHelmManaged: () => void
  hideArgoManaged: boolean
  onToggleArgoManaged: () => void
  counts: { finished: number; helm: number; argo: number; issues: number }
  onReset: () => void
}

function FilterToggle({
  checked, onToggle, label, count,
}: {
  checked: boolean
  onToggle: () => void
  label: string
  count: number
}) {
  return (
    <div
      role="checkbox"
      aria-checked={checked}
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={e => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); onToggle() } }}
      className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 hover:bg-brand-bg/50 focus:outline-none focus-visible:bg-brand-bg/50"
    >
      <Checkbox
        checked={checked}
        aria-hidden
        tabIndex={-1}
        className="pointer-events-none data-checked:border-brand data-checked:bg-brand data-checked:text-white"
      />
      <span className="flex-1 text-sm font-medium text-foreground">{label}</span>
      <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
    </div>
  )
}

export default function WorkloadFilters({
  total, filtered, isModified,
  searchQuery, onSearchChange,
  chips, activeTokens, onTokenToggle,
  showIssuesOnly, onIssuesToggle,
  showFinished, onToggleFinished,
  hideHelmManaged, onToggleHelmManaged,
  hideArgoManaged, onToggleArgoManaged,
  counts, onReset,
}: Props) {
  const menuFilterCount = (showFinished ? 1 : 0) + (hideHelmManaged ? 1 : 0) + (hideArgoManaged ? 1 : 0) + (showIssuesOnly ? 1 : 0)

  return (
    <div className="flex items-center gap-7 border-b border-gray-200 px-5 py-3.5">
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
            <FilterToggle checked={hideHelmManaged} onToggle={onToggleHelmManaged} label="Hide Helm-managed" count={counts.helm} />
            <FilterToggle checked={hideArgoManaged} onToggle={onToggleArgoManaged} label="Hide ArgoCD-managed" count={counts.argo} />
            <FilterToggle checked={showIssuesOnly} onToggle={onIssuesToggle} label="Only with issues" count={counts.issues} />
          </PopoverContent>
        </Popover>
      </div>

      <FilterFooter filtered={filtered} total={total} isModified={isModified} onReset={onReset} />
    </div>
  )
}
