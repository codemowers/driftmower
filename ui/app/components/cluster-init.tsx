"use client"

import { useEffect } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { checkConnection } from "@/lib/cluster/check-connection"
import { fetchDynamicData } from "@/lib/cluster/dynamic-data"
import { startLiveDataFetching } from "@/lib/cluster/live-data"
import { getAnalysisSocket, waitForSocketConnect } from "@/lib/cluster/analysis-socket"
import { useClusterState } from "@/lib/cluster/cluster-state"

const SOCKET_SLOT_WAIT_MS = 3000

export default function ClusterInit() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const reportId = useClusterState(state => state.reportId)
  const reportParam = searchParams.get("report")
  const searchQuery = searchParams.toString()

  // Start the polled live-data loop once for the app's lifetime.
  useEffect(() => startLiveDataFetching(), [])

  // Load the report (the one named by ?report=, else the latest) whenever the
  // param changes. We pre-warm the analysis socket in the background so it's
  // connected before the user triggers a refresh — not awaited here on purpose.
  useEffect(() => {
    void waitForSocketConnect(getAnalysisSocket(), SOCKET_SLOT_WAIT_MS)

    // Skip when the param already matches the loaded report: this fires after the
    // URL-sync effect below reflects a freshly loaded report, and re-fetching it
    // would be redundant.
    if (reportParam && reportParam === useClusterState.getState().reportId) return

    async function init() {
      await checkConnection().catch(() => {})
      await fetchDynamicData(reportParam)
    }
    void init()
  }, [reportParam])

  // Reflect the loaded report id into the URL so the view is shareable/refreshable.
  useEffect(() => {
    if (!reportId) return
    const params = new URLSearchParams(searchQuery)
    if (params.get("report") === reportId) return
    params.set("report", reportId)
    router.replace(`?${params.toString()}`)
  }, [reportId, reportParam, router, searchQuery])

  return null
}
