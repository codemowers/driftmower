"use client"

import type { ReactNode, Ref } from "react"
import { cn } from "@/lib/utils/cn"

type Props<T extends string> = {
  tabs: readonly T[]
  active: T
  onSelect: (tab: T) => void
  children: ReactNode
  // Forwarded to the root element, e.g. so a panel can locate its scroll parent.
  rootRef?: Ref<HTMLDivElement>
}

// Underlined tab strip + panel area. Pair with useTabParam for URL-backed state;
// render the active panel as children.
export default function TabBar<T extends string>({ tabs, active, onSelect, children, rootRef }: Props<T>) {
  return (
    <div ref={rootRef} className="flex flex-col gap-4">
      <div className="flex border-b border-gray-200">
        {tabs.map(tab => (
          <button
            key={tab}
            type="button"
            onClick={() => onSelect(tab)}
            className={cn(
              "px-4 py-2.5 text-sm font-medium transition-colors",
              active === tab
                ? "border-b-2 border-brand text-brand-text"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="min-h-[60vh]">{children}</div>
    </div>
  )
}
