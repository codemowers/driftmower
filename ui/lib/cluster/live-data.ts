import { checkConnection } from "./check-connection"
import { useClusterState } from "./cluster-state"
import { EXPLORER_RESOURCES_URL } from "./constants"

const LIVE_DATA_FETCH_INTERVAL = 30000

// Polls connection + explorer topology every 30s. Returns a stop function.
export function startLiveDataFetching(): () => void {
  let cancelled = false

  async function loop() {
    while (!cancelled) {
      try {
        await checkConnection()
      } catch {}

      try {
        const res = await fetch(EXPLORER_RESOURCES_URL, { cache: "no-store" })
        const data = await res.json()
        if (cancelled) return
        useClusterState.setState({ explorerResources: data })
      } catch {}

      await new Promise(r => setTimeout(r, LIVE_DATA_FETCH_INTERVAL))
    }
  }

  void loop()
  return () => {
    cancelled = true
  }
}
