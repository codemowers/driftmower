"use client"

import { useClusterState } from "@/lib/cluster/cluster-state"

function timestampSlug(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
}

export default function ReportJsonPage() {
  const { data, reportId } = useClusterState()

  const json = data ? JSON.stringify(data, null, 2) : ""

  function download() {
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }))
    const link = document.createElement("a")
    link.href = url
    link.download = `report_${timestampSlug()}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-lg font-semibold">Report JSON {reportId ? `(${reportId})` : ""}</h1>
        <button
          type="button"
          onClick={download}
          disabled={!data}
          className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50"
        >
          Download
        </button>
      </div>
      {data ? (
        <pre className="overflow-x-auto rounded-md border border-border bg-card p-4 font-mono text-xs">{json}</pre>
      ) : (
        <p className="text-sm text-muted-foreground">No report loaded.</p>
      )}
    </div>
  )
}
