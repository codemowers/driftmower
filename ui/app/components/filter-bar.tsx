"use client"

import { Search } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import type { StatusType } from "@/lib/cluster/reports"

// Shared pieces for the list filter bars (releases / workloads). The chip styles
// are exported so each bar can style its own extra toggles (Issues button,
// Filters popover) consistently.
export const FILTER_ACTIVE = "bg-brand-bg text-brand-label rounded-xl border-b-2 border-brand"
export const FILTER_INACTIVE = "bg-gray-100 text-muted-foreground rounded-xl hover:bg-gray-200"

const CHIPS: { key: StatusType; label: string }[] = [
  { key: "up_to_date",   label: "OK" },
  { key: "patch_behind", label: "Patch" },
  { key: "minor_behind", label: "Minor" },
  { key: "major_behind", label: "Major" },
  { key: "no_data",      label: "No data" },
]

export function FilterSearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (q: string) => void
  placeholder: string
}) {
  return (
    <div className="relative flex-1">
      <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-full border-[1.5px] border-gray-200 bg-gray-50 py-1.5 pl-8 pr-3 text-sm placeholder:text-muted-foreground focus:border-brand/80 focus:outline-none"
      />
    </div>
  )
}

export function StatusChips({
  activeStatuses,
  onToggle,
}: {
  activeStatuses: Set<StatusType>
  onToggle: (status: StatusType) => void
}) {
  return (
    <>
      {CHIPS.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onToggle(key)}
          className={cn(
            "px-3 py-1.5 text-xs font-semibold transition-colors",
            activeStatuses.has(key) ? FILTER_ACTIVE : FILTER_INACTIVE,
          )}
        >
          {label}
        </button>
      ))}
    </>
  )
}

export function FilterFooter({
  filtered,
  total,
  isModified,
  onReset,
}: {
  filtered: number
  total: number
  isModified: boolean
  onReset: () => void
}) {
  return (
    <div className="flex items-center gap-3 whitespace-nowrap">
      <span className="text-xs text-muted-foreground">showing {filtered} of {total}</span>
      <button
        onClick={onReset}
        className={cn("text-xs", isModified ? "text-muted-foreground hover:text-brand-label hover:underline" : "text-white")}
      >
        Reset
      </button>
    </div>
  )
}
