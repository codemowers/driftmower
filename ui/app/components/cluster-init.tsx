"use client"

import { checkConnection } from "@/lib/cluster/check-connection"
import { loadClusterSnapshot, isSnapshotStale } from "@/lib/cluster/cluster-storage"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { refreshState } from "@/lib/cluster/refresh-state"
import { useEffect } from "react"

export default function ClusterInit() {
  useEffect(() => {
    async function init() {
      await checkConnection()

      const snapshot = loadClusterSnapshot()

      if (!snapshot || isSnapshotStale(snapshot.lastRefreshed)) {
        void refreshState()
        return
      }

      useClusterState.setState({
        data: snapshot.data,
        lastRefreshed: snapshot.lastRefreshed,
        clusterName: snapshot.clusterName,
      })
    }

    void init()
  }, [])

  return null
}
