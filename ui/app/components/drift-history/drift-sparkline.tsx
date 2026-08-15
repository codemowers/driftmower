"use client"

import { layOutBands, withMinWidth } from "@/lib/cluster/drift-history/bands"
import { BAND_STYLE } from "@/lib/cluster/drift-history/band-style"
import type { Span } from "@/lib/cluster/drift-history/types"
import { cn } from "@/lib/utils/cn"

type Props = {
  spans: Span[]
  className?: string
}

export default function DriftSparkline({ spans, className }: Props) {
  const bands = withMinWidth(layOutBands(spans, 0, 1))
  if (bands.length === 0) return null

  return (
    <div
      className={cn(
        "relative isolate h-3 overflow-hidden rounded-sm shadow-[inset_0_0_0_1px_var(--color-border)]",
        className,
      )}
    >
      {bands.map((band, i) => {
        const style = BAND_STYLE[band.s]
        return (
          <div
            key={i}
            className={cn("absolute inset-y-0", style.bg, band.raised && "z-10")}
            style={{
              left: `${band.left}%`,
              width: `${band.renderWidth}%`,
              boxShadow: `inset 0 -3px 0 ${style.baseline}`,
            }}
          />
        )
      })}
    </div>
  )
}
