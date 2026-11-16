"use client"

import PrefetchLink from "@/app/components/prefetch-link"
import { cn } from "@/lib/utils/cn"
import type { ClusterResource } from "@/lib/cluster/cluster-state"
import { priorityClassName, runtimeChips } from "@/lib/cluster/pod-security"
import { availabilityChip } from "@/lib/cluster/availability"
import { usePriorityClasses } from "@/lib/features/priority-classes/use-priority-classes"
import { useContextHref } from "@/lib/hooks/use-context-href"

const CHIP = "rounded-md px-2 py-0.5 font-mono text-xs font-semibold"

// How the Pods run: their priority classes, whether a replicated workload
// survives losing a node or zone, then isolation from the host and extra
// privileges, as chips.
export default function RuntimeCell({ pods, replicated = false }: { pods: ClusterResource[]; replicated?: boolean }) {
  const { classes } = usePriorityClasses()
  const { linkTo } = useContextHref()
  const priorities = new Map<string, number | undefined>()
  for (const p of pods) if (p.priorityClassName) priorities.set(p.priorityClassName, p.priority)
  const availability = replicated ? availabilityChip(pods) : null
  const chips = [...(availability ? [availability] : []), ...runtimeChips(pods)]
  return (
    <div className="flex flex-col gap-2 px-6 py-5">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Runtime</p>
      {pods.length === 0
        ? <p className="text-sm text-muted-foreground">No running Pods</p>
        : (
          <div className="flex flex-wrap gap-1.5">
            {[...priorities].map(([name, value]) => {
              const description = classes?.find(c => c.name === name)?.description
              return (
                <PrefetchLink key={`priority-${name}`} href={linkTo("/priority-classes")} title={[`Priority ${value ?? "unknown"}`, description].filter(Boolean).join(": ")}
                  className={cn(CHIP, priorityClassName(value), "hover:underline")}>
                  {name}
                </PrefetchLink>
              )
            })}
            {chips.map(c => <span key={c.label} title={c.title} className={cn(CHIP, c.className)}>{c.label}</span>)}
          </div>
        )}
    </div>
  )
}
