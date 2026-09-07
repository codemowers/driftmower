"use client"

import { useEffect, useState } from "react"
import { fetchWorkloadMetrics, type WorkloadMetrics } from "@/lib/features/prometheus/workload-metrics"

const POLL_INTERVAL = 30000

export function useWorkloadMetrics(namespace: string, podNames: string[]): WorkloadMetrics | null {
  const [metrics, setMetrics] = useState<WorkloadMetrics | null>(null)

  const key = `${namespace}/${[...podNames].sort().join(",")}`
  const [prevKey, setPrevKey] = useState(key)
  if (prevKey !== key) {
    setPrevKey(key)
    setMetrics(null)
  }

  useEffect(() => {
    let cancelled = false
    const pods = key.split("/")[1]?.split(",").filter(Boolean) ?? []

    async function tick() {
      const data = await fetchWorkloadMetrics(namespace, pods).catch(() => null)
      if (!cancelled) setMetrics(data)
    }

    void tick()
    const id = setInterval(tick, POLL_INTERVAL)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [namespace, key])

  return metrics
}
