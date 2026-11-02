"use client"

import { useClusterState } from "@/lib/cluster/cluster-state"
import LoadError from "./load-error"
import LoadingLine from "./loading-line"

export default function ClusterDataPending() {
  const error = useClusterState(s => s.clusterResourcesError)
  if (error) return <LoadError message={`Could not load cluster data: ${error}`} />
  return <LoadingLine loading="cluster data" />
}
