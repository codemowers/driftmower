import { create } from "zustand"
import type { AnalyzeClusterProgress, ClusterData } from "./refresh-state"

export type ClusterState = {
  clusterName: string | null
  data: ClusterData | null
  isLoading: boolean
  isConnected: boolean
  error: string | null
  lastRefreshed: Date | null
  socketProgress: AnalyzeClusterProgress | null
  containerCount: number | null
}

export const useClusterState = create<ClusterState>(() => ({
  clusterName: null,
  data: null,
  isLoading: false,
  isConnected: false,
  error: null,
  lastRefreshed: null,
  socketProgress: null,
  containerCount: null,
}))
