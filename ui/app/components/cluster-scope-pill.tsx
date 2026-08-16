"use client"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export default function ClusterScopePill() {
  return (
    <Tooltip>
      <TooltipTrigger
        tabIndex={0}
        className="cursor-default rounded-full bg-muted px-2.5 py-1 font-mono text-xs text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        Cluster-scoped
      </TooltipTrigger>
      <TooltipContent side="right">
        <p className="max-w-56">
          This page shows the whole cluster. It is not filtered by the selected tenant.
        </p>
      </TooltipContent>
    </Tooltip>
  )
}
