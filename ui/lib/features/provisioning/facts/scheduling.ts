import "server-only"

import { kubeApiGet } from "@/lib/server/k8s"
import { createTtlCache } from "@/lib/utils/ttl-cache"
import { CLUSTER_FACT_TTL_MS } from "../constants"
import type { CapabilityResponse, Fact } from "../types"
import { optional } from "./tolerate"

type RawPriorityClass = {
  metadata?: { name?: string }
  value?: number
  globalDefault?: boolean
  description?: string
}

type PriorityClassFact = CapabilityResponse["priorityClasses"][number]

// The codemowers clusters ship platform-critical and observability-critical for
// platform workloads. Naming who they are for matters, because a beginner who
// sets one is quietly outranking the cluster's own components.
function meaningOf(raw: RawPriorityClass): string {
  if (raw.globalDefault) return "Applied automatically when a pod names no priority class."
  const described = raw.description?.trim()
  if (described) return described
  return "Pods with a higher value are scheduled first and evict lower-priority pods when the cluster is full."
}

async function listPriorityClasses(): Promise<Fact<PriorityClassFact[]>> {
  return await optional("priorityclasses", async () => {
    const list = await kubeApiGet<{ items?: RawPriorityClass[] }>("/apis/scheduling.k8s.io/v1/priorityclasses")
    return (list.items ?? [])
      .filter(raw => raw.metadata?.name !== undefined)
      .map(raw => ({
        name: raw.metadata!.name!,
        value: raw.value ?? 0,
        isDefault: raw.globalDefault === true,
        meaning: meaningOf(raw),
      }))
      .sort((a, b) => b.value - a.value)
  })
}

export const getPriorityClasses = createTtlCache(CLUSTER_FACT_TTL_MS, listPriorityClasses)
