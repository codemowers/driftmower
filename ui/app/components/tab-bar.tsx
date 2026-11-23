"use client"

import type { ReactNode, Ref } from "react"
import { cn } from "@/lib/utils/cn"

type Props<T extends string> = {
  tabs: readonly T[]
  active: T
  onSelect: (tab: T) => void
  children: ReactNode
  rootRef?: Ref<HTMLDivElement>
  id?: string
}

export default function TabBar<T extends string>({ tabs, active, onSelect, children, rootRef, id }: Props<T>) {
  return (
    <div id={id} ref={rootRef} className="flex flex-col gap-4">
      <div role="tablist" className="flex w-fit flex-wrap gap-1 rounded-lg bg-muted p-1">
        {tabs.map(tab => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={active === tab}
            onClick={() => onSelect(tab)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active === tab
                ? "bg-white text-foreground shadow-sm"
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
