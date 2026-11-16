"use client"

import type { WorkloadDependencies } from "@/lib/cluster/reports"
import { RESOURCE_KINDS } from "@/lib/utils/report-roots"

// The Services, Ingresses, Certificates, ConfigMaps, Secrets and claims a
// workload uses, or a namespace leaves unclaimed, grouped by kind.
export default function RelatedResources({ deps, empty }: { deps: WorkloadDependencies; empty: string }) {
  const groups = RESOURCE_KINDS.map(k => ({ ...k, names: [...(deps[k.key] ?? [])].sort() })).filter(g => g.names.length > 0)
  if (groups.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[max-content_1fr]">
      {groups.map(g => (
        <div key={g.key} className="contents">
          <dt className="text-xs font-semibold uppercase tracking-wider text-muted-foreground sm:pt-0.5">{g.label} <span className="tabular-nums">{g.names.length}</span></dt>
          <dd className="flex flex-wrap gap-1">
            {g.names.map(n => <span key={n} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{n}</span>)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

// "3 ConfigMaps · 1 Secret"-style summary of related resources.
export function resourceSummary(deps: WorkloadDependencies): string {
  return RESOURCE_KINDS.map(k => [k, (deps[k.key] ?? []).length] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${n === 1 ? k.one : k.label}`)
    .join(" · ")
}
