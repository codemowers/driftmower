"use client"

import { cn } from "@/lib/utils/cn"
import MarkdownText from "@/app/components/markdown-text"
import type { StorageClassFact } from "@/lib/features/provisioning/types"

const ROW_GRID = "grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,2fr)] items-start gap-4"

// Storage classes by name, with the description their authors gave them.
export default function StorageList({ classes }: { classes: StorageClassFact[] }) {
  if (classes.length === 0) {
    return <p className="text-sm text-muted-foreground">No storage classes are available on this cluster.</p>
  }

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
      <div className={cn(ROW_GRID, "border-b border-gray-200 px-5 py-2.5")}>
        {["Class", "Provisioner", "Description"].map(h => (
          <span key={h} className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {h}
          </span>
        ))}
      </div>

      {[...classes].sort((a, b) => a.name.localeCompare(b.name)).map(sc => (
        <div key={sc.name} className={cn(ROW_GRID, "border-b border-gray-200 px-5 py-3 last:border-b-0")}>
          <div className="flex flex-col gap-1">
            <code className="font-mono text-xs text-foreground">{sc.name}</code>
            {sc.isDefault && <span className="text-xs text-muted-foreground">cluster default</span>}
          </div>
          <span className="font-mono text-xs text-muted-foreground">{sc.provisioner}</span>
          {sc.description
            ? <MarkdownText text={sc.description} className="text-sm text-muted-foreground" />
            : <span className="text-sm text-muted-foreground">—</span>}
        </div>
      ))}
    </div>
  )
}
