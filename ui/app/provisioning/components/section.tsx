"use client"

import type { ReactNode } from "react"

// The repo's section heading: small caps label with a tabular count beside it.
// `id` makes the section a table-of-contents target; scroll-mt keeps the
// heading clear of the top edge when jumped to.
export default function Section({
  id,
  title,
  count,
  hint,
  children,
}: {
  id?: string
  title: string
  count?: number
  hint?: string
  children: ReactNode
}) {
  return (
    <section id={id} className="flex scroll-mt-6 flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
        {count !== undefined && <span className="text-xs tabular-nums text-muted-foreground">{count}</span>}
      </div>
      {hint && <p className="-mt-1 text-sm text-muted-foreground">{hint}</p>}
      {children}
    </section>
  )
}
