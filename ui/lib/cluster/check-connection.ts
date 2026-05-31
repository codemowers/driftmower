import { useClusterState } from "./cluster-state"
import { KUBERNETES_CONTEXTS_URL } from "./constants"

type KubernetesContextsResponse = {
  contexts: string[]
}

export async function checkConnection(): Promise<void> {
  try {
    const res = await fetch(KUBERNETES_CONTEXTS_URL, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    })

    if (!res.ok) throw new Error("failed to connect to backend")

    const data: KubernetesContextsResponse = await res.json()

    useClusterState.setState({
      isConnected: true,
      clusterName: data.contexts[0] ?? null,
    })
  } catch (e) {
    useClusterState.setState({
      isConnected: false,
      clusterName: null,
    })
    throw new Error("failed to connect to backend", { cause: e })
  }
}
