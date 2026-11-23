"use client"
import { ICONS } from "@/app/components/layout/icons"
import Page from "@/app/components/layout/page"

import PageHeader from "@/app/components/page-header"
import LoadingLine from "@/app/components/loading-line"
import LoadError from "@/app/components/load-error"
import { cn } from "@/lib/utils/cn"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { priorityClassName } from "@/lib/cluster/pod-security"
import { usePriorityClasses } from "@/lib/features/priority-classes/use-priority-classes"

// Every PriorityClass, highest first, with how many visible Pods use it.
export default function PriorityClassesPage() {
  const { classes, error } = usePriorityClasses()
  const resources = useClusterState(s => s.clusterResources)
  const pods = new Map<string, number>()
  for (const r of resources ?? []) if (r.kind === "Pod" && r.priorityClassName) pods.set(r.priorityClassName, (pods.get(r.priorityClassName) ?? 0) + 1)

  return (
    <>
      <Page>
        <PageHeader icon={ICONS.priorityClasses} title="Priority classes" subtitle="Scheduling priority: higher values schedule first and may preempt lower ones" />
        {error && <LoadError message={`Failed to load priority classes: ${error}`} />}
        {!classes && !error && <LoadingLine loading="priority classes" />}
        {classes && (
          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-5 py-3 font-semibold">Priority class</th>
                  <th className="px-5 py-3 text-right font-semibold">Value</th>
                  <th className="px-5 py-3 text-right font-semibold">Pods</th>
                  <th className="px-5 py-3 font-semibold">Description</th>
                </tr>
              </thead>
              <tbody>
                {[...classes].sort((a, b) => b.value - a.value).map(c => (
                  <tr key={c.name} className="border-t border-gray-100 align-top">
                    <td className="px-5 py-2.5"><span className={cn("rounded-md px-2 py-0.5 font-mono text-xs font-semibold", priorityClassName(c.value))}>{c.name}</span></td>
                    <td className="px-5 py-2.5 text-right font-mono tabular-nums">{c.value.toLocaleString()}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-muted-foreground">{pods.get(c.name) ?? 0}</td>
                    <td className="px-5 py-2.5 text-muted-foreground">{c.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Page>
    </>
  )
}
