import type { Socket } from "socket.io-client"
import { useClusterState } from "./cluster-state"
import { ANALYZE_CLUSTER_URL, REPORTS_URL } from "./constants"
import { fetchReport } from "./reports"
import { getAnalysisSocket, waitForSocketConnect } from "./analysis-socket"
import { fetchVulnerabilityReports } from "@/lib/features/vulnerability/fetch"
import { fetchJson } from "@/lib/utils/fetch-json"
import { readApiError } from "@/lib/utils/read-api-error"

export type { ImageUsage } from "./reports"

const SOCKET_CONNECT_TIMEOUT_MS = 10000
const INACTIVITY_TIMEOUT_MS = 180_000
const REPORT_STATUS_POLL_MS = 5_000
const REPORT_STATUS_QUERY = "$select[]=id&$select[]=status"
const IMAGE_IN_PROGRESS = "in_progress"
const REPORT_READY = "ready"

export type AnalysisStep = "versions" | "saving" | "images" | "loading"

export type AnalysisProgress = {
  step: AnalysisStep
  stepStartedAt: number
  containerCount: number | null
  tags: { image: string; index: number; total: number } | null
  imagesTotal: number
  imagesRead: number
}

type Payload = Record<string, unknown>
type AnalysisRun = ReturnType<typeof createAnalysisRun>

export async function refreshState(): Promise<void> {
  const run = createAnalysisRun()
  useClusterState.setState({ isLoading: true, error: null, errorSource: null, analysis: run.progress })

  const socket = getAnalysisSocket()
  const tracker = trackRun(socket, run)

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

    const reportId = await tracker.reportCreated
    const vulnerabilities = fetchVulnerabilityReports()
    await tracker.ready
    await Promise.allSettled([fetchReport(reportId), vulnerabilities])
    useClusterState.setState({ isLoading: false, analysis: null })
  } catch (e) {
    useClusterState.setState({
      error: (e as Error).message,
      errorSource: "analysis",
      isLoading: false,
      analysis: null,
    })
  } finally {
    tracker.stop()
  }
}

function payloadOf(data: unknown): Payload | null {
  return data !== null && typeof data === "object" ? (data as Payload) : null
}

function createAnalysisRun() {
  let progress: AnalysisProgress = {
    step: "versions",
    stepStartedAt: Date.now(),
    containerCount: null,
    tags: null,
    imagesTotal: 0,
    imagesRead: 0,
  }
  let reportId: string | null = null
  const createdImages = new Set<string>()
  const imageStatuses = new Map<string, string>()

  function enter(step: AnalysisStep) {
    progress = { ...progress, step, stepStartedAt: Date.now() }
  }

  function countImages() {
    let read = 0
    for (const id of createdImages) {
      const status = imageStatuses.get(id)
      if (status && status !== IMAGE_IN_PROGRESS) read++
    }
    progress = { ...progress, imagesTotal: createdImages.size, imagesRead: read }
  }

  function imageOfThisReport(data: unknown): Payload | null {
    const image = payloadOf(data)
    if (!image || reportId === null || image.reportId !== reportId) return null
    return typeof image.id === "string" ? image : null
  }

  function markReady(): boolean {
    if (progress.step === "loading") return false
    enter("loading")
    return true
  }

  return {
    get progress() {
      return progress
    },

    get reportId() {
      return reportId
    },

    get isReady() {
      return progress.step === "loading"
    },

    markReady,

    onProgress(data: unknown): boolean {
      if (progress.step !== "versions") return false
      const frame = payloadOf(data)
      if (!frame) return false

      if (frame.stage === "pods_enumerated" && typeof frame.containerCount === "number") {
        progress = { ...progress, containerCount: frame.containerCount }
        return true
      }
      if (
        frame.stage === "tag_fetched" &&
        typeof frame.index === "number" &&
        typeof frame.total === "number" &&
        typeof frame.image === "string"
      ) {
        progress = { ...progress, tags: { image: frame.image, index: frame.index, total: frame.total } }
        return true
      }
      if (frame.stage === "analysis_complete") {
        enter("saving")
        return true
      }
      return false
    },

    onReportCreated(data: unknown): boolean {
      if (reportId !== null) return false
      const report = payloadOf(data)
      if (typeof report?.id !== "string") return false
      reportId = report.id
      enter("images")
      return true
    },

    onImageCreated(data: unknown): boolean {
      const image = imageOfThisReport(data)
      if (!image) return false
      createdImages.add(image.id as string)
      countImages()
      return true
    },

    onImagePatched(data: unknown): boolean {
      const image = imageOfThisReport(data)
      if (!image || typeof image.status !== "string") return false
      imageStatuses.set(image.id as string, image.status)
      countImages()
      return true
    },

    onReportStatus(data: unknown): boolean {
      const report = payloadOf(data)
      if (reportId === null || report?.id !== reportId || report.status !== REPORT_READY) return false
      return markReady()
    },
  }
}

function trackRun(socket: Socket, run: AnalysisRun) {
  let resolveCreated!: (id: string) => void
  let rejectCreated!: (e: Error) => void
  let resolveReady!: () => void
  let rejectReady!: (e: Error) => void
  const reportCreated = new Promise<string>((resolve, reject) => {
    resolveCreated = resolve
    rejectCreated = reject
  })
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  reportCreated.catch(() => {})
  ready.catch(() => {})

  let watchdog: ReturnType<typeof setTimeout> | undefined
  let poll: ReturnType<typeof setInterval> | undefined

  function apply(changed: boolean) {
    if (!changed) return
    useClusterState.setState({ analysis: run.progress })
    armWatchdog()
    if (!run.isReady) return
    clearInterval(poll)
    clearTimeout(watchdog)
    resolveReady()
  }

  function armWatchdog() {
    clearTimeout(watchdog)
    watchdog = setTimeout(() => {
      if (run.reportId === null) {
        const timedOut = new Error("Cluster analysis timed out. Refresh the page and try again.")
        rejectCreated(timedOut)
        rejectReady(timedOut)
        return
      }
      apply(run.markReady())
    }, INACTIVITY_TIMEOUT_MS)
  }

  function checkStatus() {
    const id = run.reportId
    if (id === null || run.isReady) return
    fetchJson<unknown>(`${REPORTS_URL}/${encodeURIComponent(id)}?${REPORT_STATUS_QUERY}`)
      .then(report => {
        armWatchdog()
        apply(run.onReportStatus(report))
      })
      .catch(() => {})
  }

  const onProgress = (data: unknown) => apply(run.onProgress(data))
  const onImageCreated = (data: unknown) => apply(run.onImageCreated(data))
  const onImagePatched = (data: unknown) => apply(run.onImagePatched(data))
  const onReportPatched = (data: unknown) => apply(run.onReportStatus(data))
  const onReportCreated = (data: unknown) => {
    if (!run.onReportCreated(data)) return
    resolveCreated(run.reportId as string)
    poll = setInterval(checkStatus, REPORT_STATUS_POLL_MS)
    apply(true)
  }

  socket.on("analyze-cluster progress", onProgress)
  socket.on("reports created", onReportCreated)
  socket.on("images created", onImageCreated)
  socket.on("images patched", onImagePatched)
  socket.on("reports patched", onReportPatched)
  socket.on("connect", checkStatus)
  armWatchdog()

  return {
    reportCreated,
    ready,
    stop() {
      clearTimeout(watchdog)
      clearInterval(poll)
      socket.off("analyze-cluster progress", onProgress)
      socket.off("reports created", onReportCreated)
      socket.off("images created", onImageCreated)
      socket.off("images patched", onImagePatched)
      socket.off("reports patched", onReportPatched)
      socket.off("connect", checkStatus)
    },
  }
}
