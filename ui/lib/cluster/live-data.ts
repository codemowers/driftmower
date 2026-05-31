import { checkConnection } from "./check-connection"
import { useClusterState } from "./cluster-state"
import { EXPLORER_RESOURCES_URL } from "./constants"

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
        try {
          const res = await fetch(EXPLORER_RESOURCES_URL, { cache: "no-store" })
          const data = await res.json()
          if (cancelled) return
          useClusterState.setState({ explorerResources: data })
        } catch {}
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
