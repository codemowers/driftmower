import Link from "next/link"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export type SectionLinkCardProps = {
  href: string
  title: string
  count: number
  countEntity: string
  hint: string
  icon: LucideIcon
}

export default function SectionLinkCard({
  href,
  title,
  count,
  countEntity,
  hint,
  icon: Icon,
}: SectionLinkCardProps) {
  return (
    <Link
      href={href}
      className={cn(
        "block min-w-0 flex-1 rounded-xl border border-gray-200 bg-white p-7 shadow-xs",
        "cursor-pointer transition-colors hover:border-brand/30 hover:bg-brand-bg/40",
      )}
    >
      <div className="pointer-events-none flex select-none items-center gap-5">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-brand-icon">
          <Icon className="h-6 w-6" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-brand-text">{title}</p>
          <p className="font-mono text-sm tabular-nums text-foreground">
            {count} {countEntity} tracked
          </p>
          <p className="text-sm text-muted-foreground">{hint}</p>
        </div>
        <span className="shrink-0 text-muted-foreground" aria-hidden>
          →
        </span>
      </div>
    </Link>
  )
}
