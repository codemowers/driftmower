"use client"

import ClusterScopePill from "@/app/components/cluster-scope-pill"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useSandboxScope } from "@/lib/tenancy/sandbox-context"

// The page is only partly cluster-wide: offerings, storage and admission
// policies are, but access, hostnames, the registry and each offering's
// verdict are read for the namespaces in scope. Unscoped (an admin with no
// sandbox picked), nothing narrows it and the plain cluster pill is honest.
export default function ProvisioningScopePill() {
  const { label, namespaces } = useSandboxScope()

  if (!namespaces) return <ClusterScopePill />

  return (
    <Tooltip>
      <TooltipTrigger
        tabIndex={0}
        className="cursor-default rounded-full bg-muted px-2.5 py-1 font-mono text-xs text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {label ?? "Sandbox"}
      </TooltipTrigger>
      <TooltipContent side="right">
        <p className="max-w-56">
          Your access, hostnames, registry and whether you can create each offering are for{" "}
          {namespaces.length > 0 ? namespaces.join(", ") : "the selected sandbox"}. Offerings, storage and
          admission policies are cluster-wide.
        </p>
      </TooltipContent>
    </Tooltip>
  )
}
