"use client"

import { useCallback, useMemo } from "react"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { HISTORY_WINDOW_DAYS } from "@/lib/features/drift-history/constants"
import { windowBounds } from "@/lib/features/drift-history/reduce"
import {
  DETAIL_RESOLUTION,
  detailSeries,
  imageKey,
  type SeriesSource,
  type Window,
} from "@/lib/features/drift-history/build-series"
import { loadDriftHistory } from "@/lib/features/drift-history/store"
import { useQuery } from "@/lib/hooks/use-query"
import { useSandboxScope } from "@/lib/tenancy/sandbox-context"
import type { DriftSeries } from "@/lib/features/drift-history/types"

export type DriftHistory = {
  window: Window
  reportCount: number
  sources: SeriesSource[]
}

export type DriftHistoryState = {
  data: DriftHistory | null
  loading: boolean
  error?: string
  retry?: () => void
}

export function useDriftHistory(enabled = true, item: { workload?: string; kind?: string; image?: string; points?: number } = {}): DriftHistoryState {
  const context = useClusterState(s => s.clusterName)
  const { namespaces } = useSandboxScope()
  const scope = JSON.stringify(namespaces ? [...namespaces].sort() : null)
  const itemKey=JSON.stringify(item)
  const load = useCallback((signal: AbortSignal) => loadDriftHistory(signal, JSON.parse(scope),JSON.parse(itemKey)), [scope,itemKey])
  const result = useQuery({ key: context && enabled ? JSON.stringify([context, "drift-history", scope,itemKey]) : null, load, interval: 300_000, keepDataOnError: false })
  const raw = result.data

  const data = useMemo(() => {
    if (!raw) return null
    const { timeline } = raw
    // History is a rolling Prometheus window, independent of live inventory.
    const headTime = timeline[timeline.length - 1] ?? 0
    const { windowStart, windowEnd } = windowBounds(headTime, HISTORY_WINDOW_DAYS, timeline)

    return {
      window: { windowStart, windowEnd, timeline },
      reportCount: timeline.filter(t => t >= windowStart && t <= windowEnd).length,
      sources: raw.sources,
    }
  }, [raw])

  return { data, loading: result.loading, error: result.error, retry: result.retry }
}

export type DetailHistory = {
  series: DriftSeries[]
  windowStart: number
  windowEnd: number
  reportCount: number
}

export type DetailHistoryState = {
  data: DetailHistory | null
  loading: boolean
  error?: string
  retry?: () => void
}

function useDetail(match: (workloadGroupKey: string, image: string) => boolean,item: {workload?:string;kind?:string;image?:string}): DetailHistoryState {
  const { data, loading, error, retry } = useDriftHistory(true,{...item,points:400})

  const detail = useMemo(() => {
    if (!data) return null
    const scoped = data.sources.filter(source =>
      match(source.workloadGroupKey, imageKey(source.registry, source.repository)),
    )

    return {
      series: detailSeries(scoped, data.window, DETAIL_RESOLUTION),
      windowStart: data.window.windowStart,
      windowEnd: data.window.windowEnd,
      reportCount: data.reportCount,
    }
  }, [data, match])

  return { data: detail, loading, error, retry }
}

export function useWorkloadSeries(workloadGroupKey: string): DetailHistoryState {
  const [kind,,workload]=workloadGroupKey.split("/")
  return useDetail(useCallback(groupKey => groupKey === workloadGroupKey, [workloadGroupKey]),{kind,workload})
}

export function useImageSeries(image: string): DetailHistoryState {
  return useDetail(useCallback((_groupKey: string, candidate: string) => candidate === image, [image]),{image})
}
