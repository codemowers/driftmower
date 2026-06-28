"use client"

import { AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import type { StatusType } from "@/lib/cluster/reports"
import {
  FilterSearchInput,
  StatusChips,
  FilterFooter,
  FILTER_ACTIVE,
  FILTER_INACTIVE,
} from "@/app/components/filter-bar"

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
      <FilterSearchInput
        value={searchQuery}
        onChange={onSearchChange}
        placeholder="Search releases, charts, namespaces..."
      />

      <div className="flex items-center gap-2">
        <StatusChips activeStatuses={activeStatuses} onToggle={onStatusToggle} />

        <button
          onClick={onIssuesToggle}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold transition-colors",
            showIssuesOnly ? FILTER_ACTIVE : FILTER_INACTIVE,
          )}
        >
          <AlertTriangle className="size-3" />
          Issues
        </button>
      </div>

      <FilterFooter filtered={filtered} total={total} isModified={isFiltered} onReset={onClear} />
    </div>
  )
}
