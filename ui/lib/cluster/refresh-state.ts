import type { Socket } from "socket.io-client"
import { useClusterState, type ClusterState } from "./cluster-state"
import { ANALYZE_CLUSTER_URL } from "./constants"
import { fetchDynamicData } from "./dynamic-data"
import { getAnalysisSocket, waitForSocketConnect } from "./analysis-socket"

export type { ImageUsage } from "./reports"

const REPORT_CREATED_TIMEOUT_MS = 120000

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

  const newReportId = waitForReportCreated(socket)

  try {
    await waitForSocketConnect(socket)

    void fetch(ANALYZE_CLUSTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => {})

    const reportId = await newReportId
    useClusterState.setState({ socketProgress: null })
    await fetchDynamicData(reportId)
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

function waitForReportCreated(socket: Socket): Promise<string | null> {
  return new Promise(resolve => {
    function cleanup() {
      clearTimeout(timeout)
      socket.off("reports created", onReportCreated)
    }
    function onReportCreated(data: unknown) {
      const report = data !== null && typeof data === "object" ? (data as { id?: string }) : null
      cleanup()
      resolve(report?.id ?? null)
    }
    const timeout = setTimeout(() => {
      cleanup()
      resolve(null)
    }, REPORT_CREATED_TIMEOUT_MS)
    socket.on("reports created", onReportCreated)
  })
}
