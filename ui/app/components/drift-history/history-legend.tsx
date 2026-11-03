import { BAND_STYLE, LEGEND_ORDER, MARK_ORDER, MARK_STYLE } from "@/lib/features/drift-history/band-style"
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
      {showMarks &&
        MARK_ORDER.map((kind, i) => {
          const style = MARK_STYLE[kind]
          return (
            <span
              key={kind}
              className={cn(
                "inline-flex items-center gap-1.5 whitespace-nowrap",
                i === 0 && "border-l border-gray-200 pl-4",
              )}
            >
              <i
                className={cn("inline-block h-3.5 w-0.5", style.color, !style.dash && "bg-current")}
                style={{ backgroundImage: style.dash }}
              />
              {style.label}
            </span>
          )
        })}
    </div>
  )
}
