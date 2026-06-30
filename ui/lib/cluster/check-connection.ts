import { useClusterState } from "./cluster-state"
import { KUBERNETES_CONTEXTS_URL } from "./constants"
import { fetchJson } from "@/lib/utils/fetch-json"

type KubernetesContextsResponse = {
  contexts: string[]
}

export async function checkConnection(): Promise<void> {
  try {
    const data = await fetchJson<KubernetesContextsResponse>(KUBERNETES_CONTEXTS_URL)

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
