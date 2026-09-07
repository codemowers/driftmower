"use client"

import { useEffect, useMemo, useState } from "react"
import type { ImageUsage } from "@/lib/cluster/reports"
import type { ClusterResource } from "@/lib/cluster/cluster-state"
import type { VulnerabilityReport } from "@/lib/features/vulnerability/types"
import { deriveActions } from "@/lib/features/actions/derive"
import { postAssess } from "@/lib/features/actions/client"
import type { ActionRow, AssessState } from "@/lib/features/actions/types"

const POLL_INTERVAL = 4000

export type ActionAssessments = {
  rows: ActionRow[]
  results: Record<string, AssessState>
  unavailable: boolean
}

export function useActionAssessments(
  usages: ImageUsage[],
  root: ClusterResource | undefined,
  vulnReports: Record<string, VulnerabilityReport> | null,
): ActionAssessments {
  const rows = useMemo(() => deriveActions(usages, root, vulnReports), [usages, root, vulnReports])
  const rowsKey = rows.map(r => r.key).join("\n")
  const [results, setResults] = useState<Record<string, AssessState>>({})
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    if (rows.length === 0) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    async function tick(focus: boolean) {
      const outcome = await postAssess(rows.map(r => r.facts), focus).catch(() => null)
      if (cancelled) return
      if (outcome === "unavailable") {
        setUnavailable(true)
        return
      }
      if (outcome) {
        setResults(prev => ({ ...prev, ...outcome.results }))
        const pending = Object.values(outcome.results).some(s => s.state === "pending")
        if (!pending) return
      }
      timer = setTimeout(() => void tick(false), POLL_INTERVAL)
    }

    void tick(true)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsKey])

  return { rows, results, unavailable }
}
