import { checkConnection } from "./check-connection"
import { useClusterState } from "./cluster-state"
import { CLUSTER_RESOURCES_URL, CLUSTER_NODES_URL } from "./constants"
import { fetchClusterAlerts } from "./prometheus/alerts"
import { fetchClusterMetrics } from "./prometheus/metrics"
import { fetchNodeStorage } from "./prometheus/node-storage"

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

      const { isConnected } = useClusterState.getState()

      const shouldFetchResources = Date.now() - lastResourcesFetch >= CONNECTED_FETCH_INTERVAL
      if (shouldFetchResources) lastResourcesFetch = Date.now()

      await Promise.all([
        fetchClusterAlerts()
          .then(data => { if (!cancelled) useClusterState.setState({ prometheusAlerts: data }) })
          .catch(() => {}),
        fetchClusterMetrics()
          .then(data => { if (!cancelled) useClusterState.setState({ clusterMetrics: data }) })
          .catch(() => {}),
        fetchNodeStorage()
          .then(data => { if (!cancelled) useClusterState.setState({ nodeStorage: data }) })
          .catch(() => {}),
        ...(shouldFetchResources ? [
          fetch(CLUSTER_RESOURCES_URL, { cache: "no-store" })
            .then(res => res.json())
            .then(data => { if (!cancelled) useClusterState.setState({ clusterResources: data }) })
            .catch(() => {}),
        ] : []),
        ...(isConnected ? [
          fetch(CLUSTER_NODES_URL, { cache: "no-store" })
            .then(res => res.json())
            .then(data => { if (!cancelled) useClusterState.setState({ nodeDrift: data }) })
            .catch(() => {}),
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
