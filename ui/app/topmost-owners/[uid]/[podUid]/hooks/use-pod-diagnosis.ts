"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useClusterState, type ClusterResource } from "@/lib/cluster/cluster-state"
import { buildDiagnosisFacts, duplicatesFor, isDiagnosable, ownerKindOf } from "@/lib/features/pod-diagnosis/signature"
import { diagnosePod, recallDiagnosis, rememberDiagnoses } from "@/lib/features/pod-diagnosis/client"
import type { DiagnosisFacts, DiagnosisState } from "@/lib/features/pod-diagnosis/types"
import { useFeatureFlags } from "@/app/components/feature-flags-init"

const POLL_INTERVAL = 4000

export type PodDiagnosis = {
  facts: DiagnosisFacts | null
  state: DiagnosisState | null
  unavailable: string | null
  error: string | null
  rechecking: boolean
  recheck: () => void
}

export function usePodDiagnosis(pod: ClusterResource | null): PodDiagnosis {
  const clusterResources = useClusterState(s => s.clusterResources)
  const nodeDrift = useClusterState(s => s.nodeDrift)
  const nodeStorage = useClusterState(s => s.nodeStorage)
  const llm = useFeatureFlags(s => s.llm)
  const [openedAt] = useState(() => Date.now())
  const [fresh, setFresh] = useState<DiagnosisState | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rechecking, setRechecking] = useState(false)
  const [forceToken, setForceToken] = useState(0)

  const facts = useMemo(() => {
    if (!pod || !clusterResources) return null
    const ownerKind = ownerKindOf(pod, clusterResources)
    if (!isDiagnosable(pod, ownerKind, openedAt)) return null
    return buildDiagnosisFacts(pod, clusterResources, nodeDrift, nodeStorage, null, duplicatesFor(pod, clusterResources, openedAt))
  }, [pod, clusterResources, nodeDrift, nodeStorage, openedAt])

  const key = facts?.key ?? null
  const podUid = facts?.podUid ?? null
  const state = useMemo(() => fresh ?? (key ? recallDiagnosis(key) ?? null : null), [fresh, key])

  useEffect(() => {
    if (!podUid || !llm) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    async function tick(first: boolean) {
      const outcome = await diagnosePod(podUid as string, first && forceToken > 0).catch((e: Error) => e)
      if (cancelled) return
      if (outcome instanceof Error) {
        setError(outcome.message)
      } else if ("unavailable" in outcome) {
        setUnavailable(outcome.unavailable)
        setRechecking(false)
        return
      } else {
        setError(null)
        rememberDiagnoses(outcome.results)
        const next = outcome.key ? outcome.results[outcome.key] : undefined
        if (next) setFresh(next)
        if (!outcome.key || next?.state !== "pending") {
          setRechecking(false)
          return
        }
      }
      timer = setTimeout(() => void tick(false), POLL_INTERVAL)
    }

    void tick(true)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, forceToken, llm])

  const recheck = useCallback(() => {
    setRechecking(true)
    setForceToken(token => token + 1)
  }, [])

  return { facts, state, unavailable: llm ? unavailable : "LLM is not configured", error, rechecking, recheck }
}
