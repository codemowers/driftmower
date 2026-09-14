"use client"

import { useEffect, useRef } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { checkConnection } from "@/lib/cluster/check-connection"
import { fetchDynamicData } from "@/lib/cluster/dynamic-data"
import { refreshState } from "@/lib/cluster/refresh-state"
import { REFRESH_PARAM } from "@/lib/cluster/constants"
import { startLiveDataFetching } from "@/lib/cluster/live-data"
import { getAnalysisSocket, waitForSocketConnect } from "@/lib/cluster/analysis-socket"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { prewarmActions } from "@/lib/features/actions/client"
import { prewarmDiagnoses } from "@/lib/features/pod-diagnosis/client"

const SOCKET_SLOT_WAIT_MS = 3000

export default function ClusterInit() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const reportId = useClusterState(state => state.reportId)
  const data = useClusterState(state => state.data)
  const clusterResources = useClusterState(state => state.clusterResources)
  const nodeDrift = useClusterState(state => state.nodeDrift)
  const nodeStorage = useClusterState(state => state.nodeStorage)
  const vulnerabilityReports = useClusterState(state => state.vulnerabilityReports)
  const vulnerabilityReportsError = useClusterState(state => state.vulnerabilityReportsError)
  const reportParam = searchParams.get("report")
  const refreshParam = searchParams.get(REFRESH_PARAM)
  const searchQuery = searchParams.toString()
  const refreshTriggered = useRef(false)

  // Seed the server-side assessment queue once per report, after every input it needs has loaded.
  useEffect(() => {
    if (!reportId || !data || !clusterResources) return
    if (!vulnerabilityReports && !vulnerabilityReportsError) return
    prewarmActions(reportId, data, clusterResources, vulnerabilityReports)
  }, [reportId, data, clusterResources, vulnerabilityReports, vulnerabilityReportsError])

  // Seed the pod diagnosis queue after each resources poll, at background priority.
  useEffect(() => {
    prewarmDiagnoses(clusterResources, nodeDrift, nodeStorage)
  }, [clusterResources, nodeDrift, nodeStorage])

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

  // A one-shot analysis trigger from platform-manager, which knows it has just
  // created a sandbox that the newest report predates. The param is stripped
  // before the analysis starts, so a bookmarked or shared link never re-runs
  // it, and through the router rather than history.replaceState: useSearchParams
  // does not observe manual history writes, and the mirror effect below would
  // then keep writing the stale param back into the URL.
  //
  // The load above is left to run: the previous report is worth looking at
  // while the new one is computed, and it resolves in milliseconds against an
  // analysis that takes rather longer.
  useEffect(() => {
    if (!refreshParam || refreshTriggered.current) return
    refreshTriggered.current = true

    const params = new URLSearchParams(searchQuery)
    params.delete(REFRESH_PARAM)
    const query = params.toString()
    router.replace(query ? `?${query}` : window.location.pathname)

    void refreshState()
  }, [refreshParam, router, searchQuery])

  // Mirror the loaded report id into ?report= for shareable URLs.
  useEffect(() => {
    if (!reportId) return
    const params = new URLSearchParams(searchQuery)
    // Belt and braces: a report id arriving while the strip above is still in
    // flight must not put the trigger back in the URL.
    params.delete(REFRESH_PARAM)
    if (params.get("report") === reportId) return
    params.set("report", reportId)
    router.replace(`?${params.toString()}`)
  }, [reportId, reportParam, router, searchQuery])

  return null
}
