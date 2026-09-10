"use client"

import { Package } from "lucide-react"

import CopyButton from "@/app/components/copy-button"
import type { RegistryScope } from "@/lib/features/provisioning/types"

// Which registry to push to. Identified by being the busiest registry that is
// not a public upstream — nobody writes it down anywhere else.
export default function RegistryCard({ registry }: { registry: RegistryScope }) {
  const house = registry.registries.find(r => r.isHouseRegistry)

  if (!house) {
    return (
      <p className="text-sm text-muted-foreground">
        Every workload here pulls from a public registry, so there is no in-cluster registry to push to.
        Ask the platform team where images should live.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-card px-5 py-4">
        <div className="flex items-center gap-2">
          <Package className="size-4 shrink-0 text-brand-icon" />
          <code className="font-mono text-sm text-foreground">{house.host}</code>
          <span className="relative z-10">
            <CopyButton value={house.host} />
          </span>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          Where this cluster&rsquo;s own workloads come from&nbsp;
          <span className="tabular-nums">({house.imageCount} running containers)</span>.
        </p>
      </div>

      {registry.namespaces.map(entry => (
        <div key={entry.namespace} className="rounded-lg border border-border bg-card px-5 py-4">
          <span className="font-mono text-xs text-muted-foreground">{entry.namespace}</span>
          <p className="mt-2 text-sm text-muted-foreground">{entry.advice}</p>
          {entry.pullSecrets.length > 0 && (
            <p className="mt-2 text-sm text-muted-foreground">
              imagePullSecrets here:{" "}
              {entry.pullSecrets.map(name => (
                <code key={name} className="mr-2 font-mono text-xs text-brand-label">
                  {name}
                </code>
              ))}
            </p>
          )}
        </div>
      ))}

      {registry.registries.length > 1 && (
        <p className="text-sm text-muted-foreground">
          Also in use:{" "}
          {registry.registries
            .filter(r => !r.isHouseRegistry)
            .map(r => `${r.host} (${r.imageCount})`)
            .join(", ")}
          .
        </p>
      )}
    </div>
  )
}
