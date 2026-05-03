import type { Report } from "./reports"
import { useClusterState } from "./cluster-state"

const STORAGE_KEY = "cluster-snapshot"
const STALE_THRESHOLD_MS = 60 * 60 * 1000

type ClusterSnapshot = {
  data: Report
  lastRefreshed: string
  clusterName: string | null
}

export function saveClusterSnapshot(): void {
  const { data, lastRefreshed, clusterName } = useClusterState.getState()
  if (!data || !lastRefreshed) return
  const snapshot: ClusterSnapshot = {
    data,
    lastRefreshed: lastRefreshed.toISOString(),
    clusterName,
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
}

export function loadClusterSnapshot(): (Omit<ClusterSnapshot, "lastRefreshed"> & { lastRefreshed: Date }) | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as ClusterSnapshot
    if (!parsed.data || !parsed.lastRefreshed) return null
    return {
      ...parsed,
      lastRefreshed: new Date(parsed.lastRefreshed),
    }
  } catch {
    return null
  }
}

export function isSnapshotStale(lastRefreshed: Date): boolean {
  return Date.now() - lastRefreshed.getTime() > STALE_THRESHOLD_MS
}
