"use client"

import { useEffect, useRef } from "react"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useNetstatd, useNetstatdStable } from "@/lib/cluster/netstatd"
import type { ImageUsage } from "@/lib/cluster/reports"
import { ensureLive, podLiveFacts, staticFacts } from "@/lib/llm/pod-summary"

export function useWorkloadLivePrewarm(workloadUid: string): void {
  const data = useClusterState(s => s.data)
  const clusterResources = useClusterState(s => s.clusterResources)
  const vulnReports = useClusterState(s => s.vulnerabilityReports)
  const stable = useNetstatdStable(workloadUid)

  const prewarmed = useRef(false)
  useEffect(() => {
    prewarmed.current = false
  }, [workloadUid])

  useEffect(() => {
    if (prewarmed.current || !stable || !data) return
    const entry = Object.entries(data.report.workloadGroupMap).find(
      ([, u]) => u[0]?.workloadRootInfo?.uid === workloadUid,
    )
    if (!entry) return
    prewarmed.current = true

    const byPod = new Map<string, ImageUsage[]>()
    for (const u of entry[1]) {
      const key = `${u.namespace}/${u.podName}`
      const list = byPod.get(key)
      if (list) list.push(u)
      else byPod.set(key, [u])
    }

    const net = useNetstatd.getState()
    for (const usages of byPod.values()) {
      const first = usages[0]
      const podRes = clusterResources?.find(
        r => r.kind === "Pod" && r.name === first.podName && r.namespace === first.namespace,
      )
      if (!podRes) continue
      const facts = staticFacts(usages, vulnReports)
      const staticRisk = { riskDriver: facts.riskDriver, worstSeverity: facts.worstSeverity }
      ensureLive(podRes.uid, podLiveFacts(podRes, net, clusterResources, staticRisk))
    }
  }, [stable, data, clusterResources, vulnReports, workloadUid])
}
