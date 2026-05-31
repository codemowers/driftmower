import { useClusterState, type ClusterState } from "./cluster-state"
import { ANALYZE_CLUSTER_URL } from "./constants"
import { fetchDynamicData } from "./dynamic-data"
import { getAnalysisSocket, waitForSocketConnect } from "./analysis-socket"

export type { ImageUsage } from "./reports"

export type AnalyzeClusterProgress = {
  stage?: string
  containerCount?: number
  total?: number
  index?: number
  image?: string
}

export async function refreshState(): Promise<void> {
  useClusterState.setState({
    isLoading: true,
    error: null,
    socketProgress: null,
    containerCount: null,
  })

  const socket = getAnalysisSocket()
  const onProgress = (data: unknown) => {
    const progress =
      data !== null && typeof data === "object" ? (data as AnalyzeClusterProgress) : null
    const update: Partial<ClusterState> = { socketProgress: progress }
    if (typeof progress?.containerCount === "number") {
      update.containerCount = progress.containerCount
    }
    useClusterState.setState(update)
  }
  socket.on("analyze-cluster progress", onProgress)

  try {
    await waitForSocketConnect(socket)

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
    socket.off("analyze-cluster progress", onProgress)
  }
}
