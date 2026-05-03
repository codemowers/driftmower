"use client"

import { useEffect } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { checkConnection } from "@/lib/cluster/check-connection"
import { fetchLatestReport, fetchReport } from "@/lib/cluster/reports"
import { useClusterState } from "@/lib/cluster/cluster-state"

export default function ClusterInit() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const reportId = useClusterState(state => state.reportId)
  const reportParam = searchParams.get("report")
  const searchQuery = searchParams.toString()

  useEffect(() => {
    async function init() {
      await checkConnection()
      if (reportParam) {
        await fetchReport(reportParam)
      } else {
        await fetchLatestReport()
      }
    }
    void init()
  }, [reportParam])

  useEffect(() => {
    if (!reportId) return
    const params = new URLSearchParams(searchQuery)
    if (params.get("report") === reportId) return
    params.set("report", reportId)
    router.replace(`?${params.toString()}`)
  }, [reportId, reportParam, router, searchQuery])

  return null
}
