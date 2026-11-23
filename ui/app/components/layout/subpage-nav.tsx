"use client"

import type { ReactNode } from "react"
import PrefetchLink from "@/app/components/prefetch-link"
import { usePathname } from "@/browser/navigation"
import { cn } from "@/lib/utils/cn"

export type Subpage = { label: string; href: string; meta?: ReactNode; disabled?: boolean }

// A resource's subpages, directly under its header. The first item is the
// resource's own overview; the item whose path matches is current.
export default function SubpageNav({ items }: { items: Subpage[] }) {
  const pathname = usePathname()
  const current = (href: string) => href.split("?")[0].replace(/\/$/, "") === pathname.replace(/\/$/, "")
  return (
    <nav aria-label="Subpages" className="flex flex-wrap border-b border-gray-200">
      {items.map(item => item.disabled
        ? <span key={item.label} className="px-4 py-2.5 text-sm font-medium text-muted-foreground/50">{item.label}</span>
        : <PrefetchLink key={item.label} href={item.href} aria-current={current(item.href) ? "page" : undefined}
            className={cn("-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
              current(item.href) ? "border-brand text-brand-text" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {item.label}
            {item.meta}
          </PrefetchLink>)}
    </nav>
  )
}
