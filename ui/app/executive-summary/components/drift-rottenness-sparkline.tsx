"use client"

import type { ReactNode } from "react"
import RottennessSparkline from "@/app/components/drift-history/rottenness-sparkline"
import { useDriftHistory } from "@/lib/features/drift-history/use-drift-history"
import { cn } from "@/lib/utils/cn"

export default function DriftRottennessSparkline({ fallback }: { fallback: ReactNode }) {
  const { data } = useDriftHistory()

  const points = data?.rottenness ?? []
  if (points.length < 2) return fallback

  const delta = points[points.length - 1].score - points[0].score
  const days = Math.round((points[points.length - 1].t - points[0].t) / 86_400_000)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-muted-foreground">
        <span>0 = healthy · 1 = outdated</span>
        <span className="font-mono text-xs">
          <span
            className={cn(
              "font-semibold",
              delta < 0 ? "text-status-ok-label" : delta > 0 ? "text-status-major-label" : "text-muted-foreground",
            )}
          >
            {delta === 0 ? "flat" : `${delta < 0 ? "down" : "up"} ${Math.abs(delta).toFixed(2)}`}
          </span>
          <span> over {days}d</span>
        </span>
      </p>
      <RottennessSparkline points={points} />
    </div>
  )
}
