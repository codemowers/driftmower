"use client"

import { Search, AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils/cn"
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
  isFiltered: boolean
  searchQuery: string
  onSearchChange: (q: string) => void
  activeStatuses: Set<StatusType>
  onStatusToggle: (status: StatusType) => void
  showIssuesOnly: boolean
  onIssuesToggle: () => void
  onClear: () => void
}

export default function ReleaseFilters({
  total, filtered, isFiltered,
  searchQuery, onSearchChange,
  activeStatuses, onStatusToggle,
  showIssuesOnly, onIssuesToggle,
  onClear,
}: Props) {
  return (
    <div className="flex items-center gap-7 border-b border-gray-200 px-5 py-3.5">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={searchQuery}
          onChange={e => onSearchChange(e.target.value)}
          placeholder="Search releases, charts, namespaces..."
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

        <button
          onClick={onIssuesToggle}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold transition-colors",
            showIssuesOnly ? ACTIVE_STYLE : INACTIVE_STYLE
          )}
        >
          <AlertTriangle className="size-3" />
          Issues
        </button>
      </div>

        <div className="flex items-center gap-3 whitespace-nowrap">
          <span className="text-xs text-muted-foreground">showing {filtered} of {total}</span>
          <button onClick={onClear} className={cn("text-xs", isFiltered ? "text-muted-foreground hover:text-brand-label hover:underline" : "text-white")}>
            Reset
          </button>
        </div>
    </div>
  )
}
