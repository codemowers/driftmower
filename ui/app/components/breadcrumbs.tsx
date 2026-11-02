import PrefetchLink from "@/app/components/prefetch-link"
import { ChevronRight } from "lucide-react"

export type BreadcrumbItem = {
  label: string
  href?: string
}

type Props = {
  items: BreadcrumbItem[]
}

export default function Breadcrumbs({ items }: Props) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1 text-sm">
        {items.map((item, i) => {
          const isLast = i === items.length - 1
          return (
            <li key={i} className="flex min-w-0 items-center gap-1">
              {item.href && !isLast ? (
                <PrefetchLink
                  href={item.href}
                  className="rounded px-1.5 py-0.5 font-medium break-all text-muted-foreground transition-colors hover:bg-brand-bg hover:text-brand"
                >
                  {item.label}
                </PrefetchLink>
              ) : (
                <span
                  className={`px-1 py-0.5 font-medium break-all ${isLast ? "text-foreground" : "text-muted-foreground/60"}`}
                  aria-current={isLast ? "page" : undefined}
                >
                  {item.label}
                </span>
              )}
              {!isLast && (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
