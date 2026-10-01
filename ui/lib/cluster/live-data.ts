import { checkConnection } from "./check-connection"
import { useClusterState, type ClusterResource } from "./cluster-state"
import { CLUSTER_RESOURCES_URL, CLUSTER_NODES_URL, LIVE_PATCH_UPGRADE_URL } from "./constants"
import { fetchJson } from "@/lib/utils/fetch-json"
import type { ClusterNodesResponse } from "@/lib/cluster-resources/types"
import type { LivePatchUpgradeListResponse } from "@/lib/features/live-patch-upgrade/types"
import { fetchClusterAlerts, fetchPrometheusUrl } from "@/lib/features/prometheus/alerts"
import { fetchClusterMetrics } from "@/lib/features/prometheus/metrics"
import { fetchNodeStorage } from "@/lib/features/prometheus/node-storage"
import { seesClusterWideViewsIn, useSandboxContext } from "@/lib/tenancy/sandbox-context"

const CONNECTED_FETCH_INTERVAL = 30000
const DISCONNECTED_FETCH_INTERVAL = 5000

export function startLiveDataFetching(): () => void {
  let cancelled = false
  let lastResourcesFetch = 0

  async function loop() {
    while (!cancelled) {
      try {
        await checkConnection()
      } catch {}

      const { isConnected, prometheusUrl } = useClusterState.getState()
      const clusterWide = seesClusterWideViewsIn(useSandboxContext.getState())

      const shouldFetchResources = Date.now() - lastResourcesFetch >= CONNECTED_FETCH_INTERVAL
      if (shouldFetchResources) lastResourcesFetch = Date.now()

      await Promise.all([
        ...(prometheusUrl === null ? [
          fetchPrometheusUrl()
            .then(url => { if (!cancelled) useClusterState.setState({ prometheusUrl: url }) })
            .catch(() => {}),
        ] : []),
        ...(clusterWide ? [
          fetchClusterAlerts()
            .then(data => { if (!cancelled) useClusterState.setState({ prometheusAlerts: data }) })
            .catch(() => {}),
          fetchClusterMetrics()
            .then(data => { if (!cancelled) useClusterState.setState({ clusterMetrics: data }) })
            .catch(() => {}),
          fetchNodeStorage()
            .then(data => { if (!cancelled) useClusterState.setState({ nodeStorage: data }) })
            .catch(() => {}),
        ] : []),
        ...(shouldFetchResources ? [
          fetchJson<ClusterResource[]>(CLUSTER_RESOURCES_URL)
            .then(data => { if (!cancelled) useClusterState.setState({ clusterResources: data, clusterResourcesError: null }) })
            .catch((e: Error) => {
              console.error(`[live-data] cluster resources: ${e.message}`)
              if (!cancelled) useClusterState.setState({ clusterResourcesError: e.message })
            }),
          fetchJson<LivePatchUpgradeListResponse>(LIVE_PATCH_UPGRADE_URL)
            .then(data => { if (!cancelled) useClusterState.setState({ livePatchUpgrades: data }) })
            .catch((e: Error) => console.warn(`[live-data] temporary fixes: ${e.message}`)),
        ] : []),
        ...(isConnected && clusterWide ? [
          fetchJson<ClusterNodesResponse>(CLUSTER_NODES_URL)
            .then(data => { if (!cancelled) useClusterState.setState({ nodeDrift: data, nodeDriftError: null }) })
            .catch((e: Error) => {
              console.error(`[live-data] nodes: ${e.message}`)
              if (!cancelled) useClusterState.setState({ nodeDriftError: e.message })
            }),
        ] : []),
      ])

      const interval = isConnected
        ? CONNECTED_FETCH_INTERVAL
        : DISCONNECTED_FETCH_INTERVAL
      await new Promise(r => setTimeout(r, interval))
    }
  }

  void loop()
  return () => {
    cancelled = true
  }
}
