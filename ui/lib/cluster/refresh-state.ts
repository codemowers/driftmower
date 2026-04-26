import { io } from "socket.io-client"
import { useClusterState, type ClusterState } from "./cluster-state"
import { saveClusterSnapshot } from "./cluster-storage"

const BACKEND_URL = "https://driftmower-be.ee-lte-1.codemowers.io"
const ANALYZE_CLUSTER_URL = `${BACKEND_URL}/analyze-cluster`

export type AnalyzeClusterProgress = {
  stage?: string
  containerCount?: number
  total?: number
  index?: number
  image?: string
}

export type ImageUsage = {
  namespace: string
  podName: string
  containerName: string
  image: string
  actualTag: string
  tagStatus: string
  versionStatus: {
    latestTag: string | null
    statusType: "up_to_date" | "patch_behind" | "minor_behind" | "major_behind" | "ahead" | "no_data" | "no_version"
    majorDifference: number
    minorDifference: number
    patchDifference: number
  }
  workloadRootInfo: {
    kind: string
    name: string
    namespace: string
  }
  releaseInfo: {
    type: string
    name: string
    namespace: string
  }
}

export type ClusterData = {
  report: {
    imageUsages: ImageUsage[]
    workloadGroupMap: Record<string, ImageUsage[]>
    releaseGroupMap: Record<string, ImageUsage[]>
  }
  rotenness: {
    normalizedScore: number
    workloadScores: Record<string, {
      normalizedScore: number
      staleRepoCount: number
      totalContainers: number
      workloadRootInfo: { kind: string; name: string; namespace: string }
    }>
    releaseScores: Record<string, { normalizedScore: number; staleRepoCount: number; totalContainers: number }>
  }
  issues: Array<{ image: string; type: string; message: string }>
  clusterContext: string
}



export async function refreshState(): Promise<void> {
  useClusterState.setState({
    isLoading: true,
    error: null,
    socketProgress: null,
    containerCount: null,
  })

  const socket = io(BACKEND_URL, { transports: ["websocket"] })
  socket.on("analyze-cluster progress", (data: unknown) => {
    const progress =
      data !== null && typeof data === "object" ? (data as AnalyzeClusterProgress) : null
    const update: Partial<ClusterState> = { socketProgress: progress }
    if (typeof progress?.containerCount === "number") {
      update.containerCount = progress.containerCount
    }
    useClusterState.setState(update)
  })

  try {
    const res = await fetch(ANALYZE_CLUSTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    if (!res.ok) throw new Error(`Failed to fetch cluster data: ${res.status}`)
    const data: ClusterData = await res.json()
    useClusterState.setState({
      data,
      isLoading: false,
      lastRefreshed: new Date(),
      socketProgress: null,
      containerCount: null,
    })
    saveClusterSnapshot()
  } catch (e) {
    useClusterState.setState({
      error: String(e),
      isLoading: false,
      socketProgress: null,
      containerCount: null,
    })
  } finally {
    socket.disconnect()
  }
}
