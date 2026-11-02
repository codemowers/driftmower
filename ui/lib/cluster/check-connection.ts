import { useClusterState } from "./cluster-state"
import { KUBERNETES_CONTEXTS_URL, SESSION_ENDED_HEADER } from "./constants"
import { readApiError } from "@/lib/utils/read-api-error"

type KubernetesContextsResponse = {
  contexts: string[]
}

function signInAgain(): void {
  const login = new URL("/api/auth/login", window.location.origin)
  login.searchParams.set("returnTo", `${window.location.pathname}${window.location.search}`)
  window.location.assign(login.href)
}

export async function checkConnection(): Promise<void> {
  try {
    const res = await fetch(KUBERNETES_CONTEXTS_URL, { cache: "no-store" })
    if (res.status === 401 && res.headers.has(SESSION_ENDED_HEADER)) {
      signInAgain()
      return
    }
    if (!res.ok) throw new Error(await readApiError(res))
    const data = (await res.json()) as KubernetesContextsResponse

    useClusterState.setState({
      isConnected: true,
      connectionError: null,
      clusterName: data.contexts[0] ?? null,
    })
  } catch (e) {
    useClusterState.setState({
      isConnected: false,
      connectionError: (e as Error).message,
      clusterName: null,
    })
    throw new Error("failed to connect to backend", { cause: e })
  }
}
