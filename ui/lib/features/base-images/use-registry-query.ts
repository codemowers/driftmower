"use client"

import { useCallback } from "react"
import { callRegistry } from "@/browser/catalog"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useQuery } from "@/lib/hooks/use-query"

export function useRegistryQuery<T>(name: string, args: Record<string, unknown>, enabled = true) {
  const cluster = useClusterState(s => s.clusterName)
  const encoded = JSON.stringify(args)
  const key = JSON.stringify([cluster, name, encoded])
  const load = useCallback((signal: AbortSignal) => callRegistry<T>(name, JSON.parse(encoded), signal), [name, encoded])
  const result = useQuery({ key: enabled ? key : null, load, interval: name === "list_base_image_repositories" ? 15_000 : 60_000 })
  return result.loading || !enabled ? undefined : result
}
