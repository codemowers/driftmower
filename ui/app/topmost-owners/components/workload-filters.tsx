"use client"

import { Search, SlidersHorizontal } from "lucide-react"
import { cn } from "@/lib/utils"
import { Checkbox } from "@/components/ui/checkbox"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { StatusType } from "@/lib/cluster/reports"

const CHIPS: { key: StatusType; label: string }[] = [
  { key: "up_to_date",   label: "OK" },
  { key: "patch_behind", label: "Patch" },
  { key: "minor_behind", label: "Minor" },
  { key: "major_behind", label: "Major" },
  { key: "no_data",      label: "No data" },
]

const ACTIVE_STYLE = "bg-brand-bg text-brand-label rounded-xl border-b-2 border-brand"
const INACTIVE_STYLE = "bg-gray-100 text-muted-foreground rounded-xl hover:bg-gray-200"

type Props = {
  total: number
  filtered: number
  isModified: boolean
  searchQuery: string
  onSearchChange: (q: string) => void
  activeStatuses: Set<StatusType>
  onStatusToggle: (status: StatusType) => void
  showIssuesOnly: boolean
  onIssuesToggle: () => void
  hideFinished: boolean
  onToggleFinished: () => void
  hideHelmManaged: boolean
  onToggleHelmManaged: () => void
  counts: { finished: number; helm: number; issues: number }
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
  activeStatuses, onStatusToggle,
  showIssuesOnly, onIssuesToggle,
  hideFinished, onToggleFinished,
  hideHelmManaged, onToggleHelmManaged,
  counts, onReset,
}: Props) {
  const menuFilterCount = (hideFinished ? 1 : 0) + (hideHelmManaged ? 1 : 0) + (showIssuesOnly ? 1 : 0)

  return (
    <div className="flex items-center gap-7 border-b border-gray-200 px-5 py-3.5">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={searchQuery}
          onChange={e => onSearchChange(e.target.value)}
          placeholder="Search workloads, namespaces, managers..."
          className="w-full rounded-full border-[1.5px] border-gray-200 bg-gray-50 py-1.5 pl-8 pr-3 text-sm placeholder:text-muted-foreground focus:border-brand/80 focus:outline-none"
        />
      </div>

      <div className="flex items-center gap-2">
        {CHIPS.map(({ key, label }) => {
          const isActive = activeStatuses.has(key)
          return (
            <button
              key={key}
              onClick={() => onStatusToggle(key)}
              className={cn("px-3 py-1.5 text-xs font-semibold transition-colors", isActive ? ACTIVE_STYLE : INACTIVE_STYLE)}
            >
              {label}
            </button>
          )
        })}

        <div className="mx-1 h-5 w-px bg-gray-200" />

        <Popover>
          <PopoverTrigger
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold transition-colors",
              menuFilterCount > 0 ? ACTIVE_STYLE : INACTIVE_STYLE
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
            <FilterToggle checked={hideFinished} onToggle={onToggleFinished} label="Hide finished workloads" count={counts.finished} />
            <FilterToggle checked={hideHelmManaged} onToggle={onToggleHelmManaged} label="Hide Helm-managed" count={counts.helm} />
            <FilterToggle checked={showIssuesOnly} onToggle={onIssuesToggle} label="Only with issues" count={counts.issues} />
          </PopoverContent>
        </Popover>
      </div>

      <div className="flex items-center gap-3 whitespace-nowrap">
        <span className="text-xs text-muted-foreground">showing {filtered} of {total}</span>
        <button onClick={onReset} className={cn("text-xs", isModified ? "text-muted-foreground hover:text-brand-label hover:underline" : "text-white")}>
          Reset
        </button>
      </div>
    </div>
  )
}
