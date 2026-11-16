"use client"

import type { ReactNode } from "react"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { prometheusGraphLink } from "@/lib/features/prometheus/links"
import { cn } from "@/lib/utils/cn"

// Links its children to a Prometheus graph of exprs when Prometheus's public
// address is known; otherwise renders them as they are.
export default function GraphLink({ exprs, range, className, children }: { exprs: string[] | null | undefined; range?: string; className?: string; children: ReactNode }) {
  const base = useClusterState(s => s.prometheusUrl)
  if (!base || !exprs?.length) return <>{children}</>
  return (
    <a href={prometheusGraphLink(base, exprs, range)} target="_blank" rel="noreferrer" title="Open in Prometheus" className={cn("hover:underline", className)}>
      {children}
    </a>
  )
}
