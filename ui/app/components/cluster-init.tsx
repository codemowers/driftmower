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

  useEffect(() => {
    getAnalysisSocket()
  }, [])

  useEffect(() => {
    async function init() {
      await waitForSocketConnect(getAnalysisSocket(), SOCKET_SLOT_WAIT_MS)
      await checkConnection()
      await fetchDynamicData(reportParam)
    }
    void init()
  }, [reportParam])

  useEffect(() => startLiveDataFetching(), [])

  useEffect(() => {
    if (!reportId) return
    const params = new URLSearchParams(searchQuery)
    if (params.get("report") === reportId) return
    params.set("report", reportId)
    router.replace(`?${params.toString()}`)
  }, [reportId, reportParam, router, searchQuery])

  return null
}
