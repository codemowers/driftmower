"use client"

import { useCallback } from "react"
import { useQuery } from "@/lib/hooks/use-query"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { fetchWorkloadMetrics, type WorkloadMetrics } from "@/lib/features/prometheus/workload-metrics"

export function useWorkloadMetrics(namespace: string, workloadUid: string, podNames: string[]): WorkloadMetrics | null {
  const cluster = useClusterState(s => s.clusterName)
  const key = JSON.stringify([cluster, namespace, workloadUid, [...podNames].sort()])
  const load = useCallback((signal: AbortSignal) => fetchWorkloadMetrics(namespace, workloadUid, signal), [namespace, workloadUid])
  return useQuery({ key: namespace && workloadUid ? key : null, load, interval: 30_000, keepDataOnError: false }).data ?? null
}
