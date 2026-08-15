import { BAND_STYLE, LEGEND_ORDER } from "@/lib/cluster/drift-history/band-style"
import { cn } from "@/lib/utils/cn"

export default function HistoryLegend({ showMarks = true }: { showMarks?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-gray-100 pt-3 text-xs text-muted-foreground">
      {LEGEND_ORDER.map(status => {
        const style = BAND_STYLE[status]
        return (
          <span key={status} className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <i
              className={cn("inline-block h-3 w-4 rounded-sm", style.bg)}
              style={{ boxShadow: `inset 0 -2px 0 ${style.baseline}, inset 0 0 0 1px var(--color-border)` }}
            />
            {style.label}
          </span>
        )
      })}
      {showMarks && (
        <>
          <span className="inline-flex items-center gap-1.5 border-l border-gray-200 pl-4 whitespace-nowrap">
            <i className="inline-block h-3.5 w-0.5 rounded-full bg-foreground/45" />
            Deployed
          </span>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <i className="inline-block h-3.5 border-l-2 border-dashed border-foreground/35" />
            Upstream release
          </span>
        </>
      )}
    </div>
  )
}
