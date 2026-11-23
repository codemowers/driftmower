"use client"

import { useMemo } from "react"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { scopeKey, scopeUsages, type FindingScope } from "@/lib/cluster/scope"

// The running image usages of a scope, stable while the report is unchanged.
export function useScopeUsages(scope: FindingScope) {
  const data = useClusterState(s => s.data)
  const key = scopeKey(scope)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => data ? scopeUsages(data.report.imageUsages, scope) : null, [data, key])
}
