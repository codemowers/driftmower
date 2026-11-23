import type { ReactNode } from "react"
import { cn } from "@/lib/utils/cn"

export const SECTION_LABEL = "text-xs font-semibold uppercase tracking-wider text-muted-foreground"

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cn(SECTION_LABEL, className)}>{children}</h2>
}

// Every bordered content block. Tables and lists pass flush.
export default function Card({ title, meta, actions, flush = false, className, children }: {
  title?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  flush?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <section className={cn("min-w-0 rounded-xl border border-gray-200 bg-white", className)}>
      {(title || meta || actions) && (
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-gray-200 px-5 py-3">
          {title && <SectionLabel>{title}</SectionLabel>}
          {meta && <span className="text-xs text-muted-foreground">{meta}</span>}
          {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={flush ? "" : "flex flex-col gap-4 p-5"}>{children}</div>
    </section>
  )
}
