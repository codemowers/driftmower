"use client"

import { Button } from "@/components/ui/button"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { refreshState } from "@/lib/cluster/refresh-state"
import { useState } from "react"
import PageHeader from "../components/page-header"

export default function OidcApplicationsPage() {
  const {
    data,
    isLoading,
    error,
    lastRefreshed,
    isConnected,
    clusterName,
  } = useClusterState()
  const [tempRefreshUsed, setTempRefreshUsed] = useState(false)

  function handleTempRefresh() {
    if (tempRefreshUsed) return
    setTempRefreshUsed(true)
    void refreshState()
  }

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-10 px-7 py-12">
      <PageHeader title="OIDC Applications" subtitle="Discovered applications" />

      <div className="mt-6">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={tempRefreshUsed}
          onClick={handleTempRefresh}
        >
          {tempRefreshUsed ? "Temp refresh (used)" : "Temp: refresh cluster"}
        </Button>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        (temp) isConnected: {String(isConnected)} · clusterName:{" "}
        {clusterName ?? "null"}
      </p>

      {lastRefreshed && <p className="mt-6 text-sm">{lastRefreshed.toISOString()}</p>}

      <div className="mt-8">
        {isLoading && "Loading…"}
        {error && `Error: ${error}`}
        {!isLoading && !error && data && (
          <pre className="text-xs">{JSON.stringify(data, null, 2)}</pre>
        )}
      </div>
      </main>
    </div>
  )
}
