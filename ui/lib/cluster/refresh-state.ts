import { io, type Socket } from "socket.io-client"
import { useClusterState, type ClusterState } from "./cluster-state"
import { ANALYZE_CLUSTER_URL, CONFIG_URL } from "./constants"
import { fetchDynamicData } from "./dynamic-data"

export type { ImageUsage } from "./reports"

export type AnalyzeClusterProgress = {
  stage?: string
  containerCount?: number
  total?: number
  index?: number
  image?: string
}

let cachedBackendPublicUrl: string | null = null

async function getBackendPublicUrl(): Promise<string> {
  if (cachedBackendPublicUrl !== null) return cachedBackendPublicUrl
  const res = await fetch(CONFIG_URL, { cache: "no-store" })
  if (!res.ok) throw new Error(`Failed to fetch runtime config: ${res.status}`)
  const { backendPublicUrl } = (await res.json()) as { backendPublicUrl: string }
  if (!backendPublicUrl) {
    throw new Error("BACKEND_PUBLIC_URL is not configured on the server")
  }
  cachedBackendPublicUrl = backendPublicUrl
  return backendPublicUrl
}

export async function refreshState(): Promise<void> {
  useClusterState.setState({
    isLoading: true,
    error: null,
    socketProgress: null,
    containerCount: null,
  })

  let socket: Socket | null = null
  try {
    const backendPublicUrl = await getBackendPublicUrl()
    socket = io(backendPublicUrl, { transports: ["websocket"] })
    socket.on("analyze-cluster progress", (data: unknown) => {
      const progress =
        data !== null && typeof data === "object" ? (data as AnalyzeClusterProgress) : null
      const update: Partial<ClusterState> = { socketProgress: progress }
      if (typeof progress?.containerCount === "number") {
        update.containerCount = progress.containerCount
      }
      useClusterState.setState(update)
    })

    const res = await fetch(ANALYZE_CLUSTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    if (!res.ok) throw new Error(`Failed to fetch cluster data: ${res.status}`)
    useClusterState.setState({ socketProgress: null })
    await fetchDynamicData()
    useClusterState.setState({ isLoading: false })
  } catch (e) {
    useClusterState.setState({
      error: String(e),
      isLoading: false,
      socketProgress: null,
      containerCount: null,
    })
  } finally {
    socket?.disconnect()
  }
}
