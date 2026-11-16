"use client"

import { useCallback } from "react"
import { useQuery } from "@/lib/hooks/use-query"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { fetchPodMetrics, type PodMetrics } from "@/lib/features/prometheus/pod-metrics"

export function usePodMetrics(namespace: string, workloadUid: string, name: string): PodMetrics | null {
  const cluster = useClusterState(s => s.clusterName)
  const key = JSON.stringify([cluster, namespace, workloadUid, name])
  const load = useCallback((signal: AbortSignal) => fetchPodMetrics(namespace, workloadUid, name, signal), [namespace, workloadUid, name])
  return useQuery({ key: namespace && workloadUid && name ? key : null, load, interval: 30_000, keepDataOnError: false }).data ?? null
}
