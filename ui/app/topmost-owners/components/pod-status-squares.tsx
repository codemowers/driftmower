import { cn } from "@/lib/utils/cn"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { POD_SEVERITY_STYLE, POD_SQUARE_ORDER, type PodSeverity } from "@/lib/cluster/pod-status-style"

const MAX_ROWS = 3
const SQUARES_PER_ROW = 7
const MAX_SQUARES = MAX_ROWS * SQUARES_PER_ROW

export default function PodStatusSquares({ counts }: { counts: Record<PodSeverity, number> }) {
  const ordered = POD_SQUARE_ORDER.flatMap(severity =>
    Array<PodSeverity>(counts[severity]).fill(severity),
  )
  const shown = ordered.slice(0, MAX_SQUARES)
  const hiddenCount = ordered.length - shown.length

  const breakdown = POD_SQUARE_ORDER
    .filter(severity => counts[severity] > 0)
    .map(severity => `${counts[severity]} ${POD_SEVERITY_STYLE[severity].label.toLowerCase()}`)
    .join(" · ")

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex w-fit items-center gap-1.5">
          <div className="flex max-w-[82px] flex-wrap gap-0.5">
            {shown.map((severity, i) => (
              <span key={i} className={cn("size-2.5 rounded-xs border-[1.5px]", POD_SEVERITY_STYLE[severity].square)} />
            ))}
          </div>
          {hiddenCount > 0 && (
            <span className="text-xs tabular-nums text-muted-foreground">+{hiddenCount}</span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent>{breakdown}</TooltipContent>
    </Tooltip>
  )
}
