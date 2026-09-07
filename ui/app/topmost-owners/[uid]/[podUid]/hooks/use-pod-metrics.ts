"use client"

import { useEffect, useState } from "react"
import { fetchPodMetrics, type PodMetrics } from "@/lib/features/prometheus/pod-metrics"

const POLL_INTERVAL = 30000

export function usePodMetrics(namespace: string, name: string): PodMetrics | null {
  const [metrics, setMetrics] = useState<PodMetrics | null>(null)

  const podKey = `${namespace}/${name}`
  const [prevKey, setPrevKey] = useState(podKey)
  if (prevKey !== podKey) {
    setPrevKey(podKey)
    setMetrics(null)
  }

  useEffect(() => {
    let cancelled = false

    async function tick() {
      const data = await fetchPodMetrics(namespace, name).catch(() => null)
      if (!cancelled) setMetrics(data)
    }

    void tick()
    const id = setInterval(tick, POLL_INTERVAL)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [namespace, name])

  return metrics
}
