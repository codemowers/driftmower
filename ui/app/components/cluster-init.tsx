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

  // Load ?report= (else latest) when the param changes; pre-warm the socket, not awaited.
  useEffect(() => {
    void waitForSocketConnect(getAnalysisSocket(), SOCKET_SLOT_WAIT_MS)

    // Param already matches the loaded report; skip the redundant re-fetch.
    if (reportParam && reportParam === useClusterState.getState().reportId) return

    async function init() {
      await checkConnection().catch(() => {})
      await fetchDynamicData(reportParam)
    }
    void init()
  }, [reportParam])

  // Mirror the loaded report id into ?report= for shareable URLs.
  useEffect(() => {
    if (!reportId) return
    const params = new URLSearchParams(searchQuery)
    if (params.get("report") === reportId) return
    params.set("report", reportId)
    router.replace(`?${params.toString()}`)
  }, [reportId, reportParam, router, searchQuery])

  return null
}
