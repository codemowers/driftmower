"use client"

import { useMemo } from "react"
import { groupBy, sparklines } from "@/lib/features/drift-history/aggregate"
import { BULK_RESOLUTION, imageKey, type SeriesSource } from "@/lib/features/drift-history/build-series"
import type { DriftSparkline } from "@/lib/features/drift-history/types"
import { useDriftHistory } from "./use-drift-history"

function useBulk(
  keyOf: (source: SeriesSource) => string,
  only: (source: SeriesSource) => boolean,
  enabled: boolean,
): Record<string, DriftSparkline> {
  const { data } = useDriftHistory(enabled)

  return useMemo(() => {
    if (!data) return {}
    const { window, sources } = data
    const items = sparklines(
      groupBy(sources.filter(only), keyOf),
      window.timeline,
      window.windowStart,
      window.windowEnd,
      BULK_RESOLUTION,
    )
    return Object.fromEntries(items.map(item => [item.key, item]))
  }, [data, keyOf, only])
}

const byImage = (source: SeriesSource) => imageKey(source.registry, source.repository)
const byWorkload = (source: SeriesSource) => source.workloadGroupKey
const always = () => true
// The backend files controller-less containers here; they are images, not workloads.
const owned = (source: SeriesSource) => source.workloadGroupKey !== "unknown"

export function useImageHistory(enabled = true): Record<string, DriftSparkline> {
  return useBulk(byImage, always, enabled)
}

export function useWorkloadHistory(enabled = true): Record<string, DriftSparkline> {
  return useBulk(byWorkload, owned, enabled)
}
