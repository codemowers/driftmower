"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
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
import { loadDriftHistory, type DriftHistoryData } from "@/lib/features/drift-history/store"
import type { DriftSeries, RottennessPoint } from "@/lib/features/drift-history/types"

export type DriftHistory = {
  window: Window
  reportCount: number
  rottenness: RottennessPoint[]
  sources: SeriesSource[]
}

export type DriftHistoryState = {
  data: DriftHistory | null
  loading: boolean
  error: boolean
}

type Loaded = { context: string; data: DriftHistoryData | null; error: boolean }

const DAY_MS = 86_400_000

export function useDriftHistory(enabled = true): DriftHistoryState {
  const context = useClusterState(s => s.clusterName)
  const [result, setResult] = useState<Loaded | null>(null)

  useEffect(() => {
    if (!context || !enabled) return
    let cancelled = false

    const update=()=>void loadDriftHistory(context)
      .then(data=>{if(!cancelled)setResult({context,data,error:false})})
      .catch(()=>{if(!cancelled)setResult({context,data:null,error:true})})
    update()
    const timer=setInterval(update,300_000)
    return()=>{cancelled=true;clearInterval(timer)}
  },[context,enabled])

  const settled = result !== null && result.context === context
  const raw = settled ? result.data : null

  const data = useMemo(() => {
    if (!raw) return null
    const { timeline } = raw
    // History is a rolling Prometheus window, independent of live inventory.
    const headTime = timeline[timeline.length - 1] ?? 0
    const { windowStart, windowEnd } = windowBounds(headTime, HISTORY_WINDOW_DAYS, timeline)

    const scoreStart = windowEnd - HISTORY_WINDOW_DAYS * DAY_MS

    return {
      window: { windowStart, windowEnd, timeline },
      reportCount: timeline.filter(t => t >= windowStart && t <= windowEnd).length,
      rottenness: raw.rottenness.filter(point => point.t >= scoreStart && point.t <= windowEnd),
      sources: raw.sources,
    }
  }, [raw])

  if (!context || !enabled) return { data: null, loading: false, error: false }

  return { data, loading: !settled, error: settled ? result.error : false }
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
  error: boolean
}

function useDetail(match: (workloadGroupKey: string, image: string) => boolean): DetailHistoryState {
  const { data, loading, error } = useDriftHistory()

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

  return { data: detail, loading, error }
}

export function useWorkloadSeries(workloadGroupKey: string): DetailHistoryState {
  return useDetail(useCallback(groupKey => groupKey === workloadGroupKey, [workloadGroupKey]))
}

export function useImageSeries(image: string): DetailHistoryState {
  return useDetail(useCallback((_groupKey: string, candidate: string) => candidate === image, [image]))
}
