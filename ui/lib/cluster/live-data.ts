import { checkConnection } from "./check-connection"
import { useClusterState } from "./cluster-state"
import { CLUSTER_RESOURCES_URL, CLUSTER_NODES_URL } from "./constants"

const CONNECTED_FETCH_INTERVAL = 30000
const DISCONNECTED_FETCH_INTERVAL = 5000

export function startLiveDataFetching(): () => void {
  let cancelled = false

  async function loop() {
    while (!cancelled) {
      try {
        await checkConnection()
      } catch {}

      const { isConnected } = useClusterState.getState()

      if (isConnected) {
        await Promise.all([
          fetch(CLUSTER_RESOURCES_URL, { cache: "no-store" })
            .then(res => res.json())
            .then(data => { if (!cancelled) useClusterState.setState({ clusterResources: data }) })
            .catch(() => {}),
          fetch(CLUSTER_NODES_URL, { cache: "no-store" })
            .then(res => res.json())
            .then(data => { if (!cancelled) useClusterState.setState({ nodeDrift: data }) })
            .catch(() => {}),
        ])
      }

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
