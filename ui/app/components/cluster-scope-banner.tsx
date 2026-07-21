"use client"

import { Info } from "lucide-react"
import { useTenantScope } from "@/lib/tenancy/tenant-context"

// Slim notice for pages that are inherently cluster/fleet-level and ignore
// the selected tenant context.
export default function ClusterScopeBanner() {
  const { tenant } = useTenantScope()
  if (!tenant) return null

  return (
    <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-muted/50 px-4 py-2 text-sm text-muted-foreground">
      <Info className="size-4 shrink-0" aria-hidden />
      <span>
        Cluster-scoped view — this page is not filtered by the selected tenant{" "}
        <span className="font-mono text-foreground">{tenant}</span>.
      </span>
    </div>
  )
}
