"use client"

import type { ReactNode } from "react"
import { Search } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import { Checkbox } from "@/components/ui/checkbox"

export const FILTER_ACTIVE = "bg-brand-bg text-brand-label rounded-xl border-b-2 border-brand"
export const FILTER_INACTIVE = "bg-gray-100 text-muted-foreground rounded-xl hover:bg-gray-200"

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

export function FilterToggle({
  checked,
  onToggle,
  label,
  count,
}: {
  checked: boolean
  onToggle: () => void
  label: ReactNode
  count?: number
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
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{label}</span>
      {count !== undefined && (
        <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
      )}
    </div>
  )
}

export function FilterChips({
  chips,
  active,
  onToggle,
}: {
  chips: { token: string; label: string }[]
  active: Set<string>
  onToggle: (token: string) => void
}) {
  return (
    <>
      {chips.map(({ token, label }) => (
        <button
          key={token}
          onClick={() => onToggle(token)}
          className={cn(
            "px-3 py-1.5 text-xs font-semibold transition-colors",
            active.has(token) ? FILTER_ACTIVE : FILTER_INACTIVE,
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
