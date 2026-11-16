"use client"

import { ArrowRight, ScrollText } from "lucide-react"
import LogRate from "./log-rate-card"
import PrefetchLink from "@/app/components/prefetch-link"

// A link to a logs subpage, in the style of the network card.
export default function LogsCard({ href, scope, namespace, pod, podNames }: { href: string; scope: string; namespace: string; pod?: string; podNames?: string[] }) {
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Logs</p>
      <PrefetchLink href={href} className="group flex items-center gap-4 rounded-xl border border-gray-200 bg-white px-5 py-4 transition-colors hover:border-brand/40 hover:bg-brand-bg/30">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-bg text-brand-icon">
          <ScrollText className="size-6" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">Logs</p>
          <p className="mt-1 truncate text-xs text-muted-foreground">Latest lines · {scope}</p>
        </div>
        <LogRate namespace={namespace} pod={pod} podNames={podNames} />
        <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-brand-text" />
      </PrefetchLink>
    </div>
  )
}
