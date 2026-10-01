import type { Socket } from "socket.io-client"
import { useClusterState, type ClusterState } from "./cluster-state"
import { ANALYZE_CLUSTER_URL } from "./constants"
import { fetchDynamicData } from "./dynamic-data"
import { getAnalysisSocket, waitForSocketConnect } from "./analysis-socket"
import { readApiError } from "@/lib/utils/read-api-error"

export type { ImageUsage } from "./reports"

const REPORT_CREATED_TIMEOUT_MS = 120000
const SOCKET_CONNECT_TIMEOUT_MS = 10000

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
  newReportId.catch(() => {})

  try {
    await waitForSocketConnect(socket, SOCKET_CONNECT_TIMEOUT_MS)
    if (!socket.connected) {
      throw new Error("The analysis stream did not connect. Refresh the page and try again.")
    }

    const response = await fetch(ANALYZE_CLUSTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    if (!response.ok) {
      throw new Error(`Starting cluster analysis failed: ${await readApiError(response)}`)
    }

    const reportId = await newReportId
    if (!reportId) {
      throw new Error("Cluster analysis did not produce a report. Refresh the page and try again.")
    }
    useClusterState.setState({ socketProgress: null })
    await fetchDynamicData(reportId)
    useClusterState.setState({ isLoading: false })
  } catch (e) {
    useClusterState.setState({
      error: (e as Error).message,
      isLoading: false,
      socketProgress: null,
      containerCount: null,
    })
  } finally {
    socket.off("analyze-cluster progress", onProgress)
  }
}

function waitForReportCreated(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    function cleanup() {
      clearTimeout(timeout)
      socket.off("reports created", onReportCreated)
    }
    function onReportCreated(data: unknown) {
      const report = data !== null && typeof data === "object" ? (data as { id?: string }) : null
      cleanup()
      if (report?.id) resolve(report.id)
      else reject(new Error("Cluster analysis returned no report id."))
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error("Cluster analysis timed out. Refresh the page and try again."))
    }, REPORT_CREATED_TIMEOUT_MS)
    socket.on("reports created", onReportCreated)
  })
}
