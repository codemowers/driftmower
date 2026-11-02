"use client"

import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils/cn"
import { SEVERITY_STYLE } from "@/lib/cluster/styles/status-style"
import { formatSize, ARTIFACT_CLASSES, type ArtifactClass, type ClassifiedArtifact } from "../data"

const GRID = "grid-cols-[1.5rem_minmax(0,1fr)_5rem_6rem]"

function DriftPill({ drift }: { drift: ClassifiedArtifact["drift"] }) {
  if (drift === "ahead") {
    return <span className="rounded-md bg-brand-bg px-3 py-1.5 text-xs font-semibold text-brand-label">Ahead</span>
  }
  const style = SEVERITY_STYLE[drift]
  if (style) {
    return <span className={cn("rounded-md px-3 py-1.5 text-xs font-semibold", style.bg, style.text)}>{style.label}</span>
  }
  return <span className="rounded-md bg-gray-100 px-3 py-1.5 text-xs font-semibold text-muted-foreground">No data</span>
}

type Props = {
  artifacts: ClassifiedArtifact[]
  selected: Set<string>
  onToggle: (id: string) => void
  onToggleClass: (category: ArtifactClass) => void
}

export default function ArtifactList({ artifacts, selected, onToggle, onToggleClass }: Props) {
  const ordered = ARTIFACT_CLASSES.flatMap(cls => artifacts.filter(a => a.category === cls.id))

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white">
      <div className="flex shrink-0 flex-wrap items-center gap-x-8 gap-y-2 border-b border-gray-200 py-3.5 pl-6 pr-4">
        {ARTIFACT_CLASSES.map(cls => {
          const rows = artifacts.filter(a => a.category === cls.id)
          const inClass = rows.filter(a => selected.has(a.id)).length
          const allSelected = inClass === rows.length
          return (
            <div
              key={cls.id}
              role="button"
              tabIndex={0}
              onClick={() => onToggleClass(cls.id)}
              className="flex cursor-pointer select-none items-center gap-2.5"
            >
              <span className="pointer-events-none">
                <Checkbox checked={allSelected} />
              </span>
              <span className="text-sm font-medium text-foreground">{cls.label}</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {inClass}/{rows.length}
              </span>
            </div>
          )
        })}
      </div>

      <div className="min-h-0 flex-1 divide-y divide-gray-100 overflow-y-auto">
        {ordered.map(a => (
          <div
            key={a.id}
            role="button"
            tabIndex={0}
            onClick={() => onToggle(a.id)}
            className={cn(
              "grid cursor-pointer select-none items-center gap-4 py-3 pl-6 pr-4 transition-colors hover:bg-brand-bg/40",
              GRID,
            )}
          >
            <span className="pointer-events-none">
              <Checkbox checked={selected.has(a.id)} />
            </span>
            <div className="min-w-0">
              <p className="truncate font-mono text-sm text-foreground">
                {a.registry}/{a.repository}
                <span className="text-muted-foreground">:{a.tag}</span>
              </p>
              <p className="truncate font-mono text-xs text-muted-foreground">{a.namespace}</p>
            </div>
            <span className="text-sm tabular-nums text-muted-foreground">{formatSize(a.sizeBytes)}</span>
            <div>
              <DriftPill drift={a.drift} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
