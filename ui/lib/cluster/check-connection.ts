import { useClusterState } from "./cluster-state"

const BACKEND_URL = "https://driftmower-be.ee-lte-1.codemowers.io"
const KUBERNETES_CONTEXTS_URL = `${BACKEND_URL}/kubernetes-contexts`

type KubernetesContextsResponse = {
  contexts: string[]
}

export async function checkConnection(): Promise<void> {
  console.log("CHECKING CONNECTION ");

  useClusterState.setState({
    isConnected: false,
    clusterName: null
  });

  try{
    const res = await fetch(KUBERNETES_CONTEXTS_URL, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (!res.ok) throw new Error("failed to connect to backend");

    const data: KubernetesContextsResponse = await res.json();

    useClusterState.setState({
      isConnected: true,
      clusterName: data.contexts[0] ?? null,
    });
  } catch (e) {
    throw new Error("failed to connect to backend", { cause: e })
  }
}
