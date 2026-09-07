"use client"

import { useEffect, useMemo, useState } from "react"
import { useParams } from "next/navigation"
import { useClusterState, type ClusterResource } from "@/lib/cluster/cluster-state"
import { useNetstatd, useNetstatdStable } from "@/lib/features/netstatd"
import { ensureLive, getLiveText, podLiveFacts, staticFacts, streamStaticSummary } from "@/lib/features/pod-summary"

type Props = { pod: ClusterResource }

export default function PodLlmSummary({ pod }: Props) {
  const { uid: workloadUid } = useParams<{ uid: string }>()
  const data = useClusterState(s => s.data)
  const vulnReports = useClusterState(s => s.vulnerabilityReports)
  const clusterResources = useClusterState(s => s.clusterResources)
  const stable = useNetstatdStable(workloadUid)

  const podUsages = useMemo(
    () => data?.report.imageUsages.filter(u => u.podName === pod.name && u.namespace === pod.namespace) ?? [],
    [data, pod.name, pod.namespace],
  )

  const staticRisk = useMemo(() => {
    const facts = staticFacts(podUsages, vulnReports)
    return { riskDriver: facts.riskDriver, worstSeverity: facts.worstSeverity }
  }, [podUsages, vulnReports])

  const [staticText, setStaticText] = useState("")
  const [staticDone, setStaticDone] = useState(false)
  const [liveText, setLiveText] = useState(() => getLiveText(pod.uid) ?? "")

  useEffect(() => {
    let active = true
    void (async () => {
      setStaticText("")
      setStaticDone(false)
      try {
        for await (const chunk of streamStaticSummary(podUsages, vulnReports)) {
          if (!active) return
          setStaticText(prev => prev + chunk)
        }
      } catch {
        if (active) setStaticText("Summary unavailable.")
      } finally {
        if (active) setStaticDone(true)
      }
    })()
    return () => {
      active = false
    }
  }, [podUsages, vulnReports])

  useEffect(() => {
    const id = setInterval(() => {
      if (stable && podUsages.length > 0 && getLiveText(pod.uid) === null) {
        ensureLive(pod.uid, podLiveFacts(pod, useNetstatd.getState(), clusterResources, staticRisk))
      }
      setLiveText(getLiveText(pod.uid) ?? "")
    }, 1_000)
    return () => clearInterval(id)
  }, [stable, pod, podUsages, clusterResources, staticRisk])

  const placeholder = !staticText && !staticDone
  const showLive = podUsages.length > 0 && staticDone
  const liveStarted = stable
  const pending = liveStarted ? "Generating…" : "Observing netstatd traffic…"

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        AI Insight
      </p>
      <div className="rounded-xl border border-border border-l-[3px] border-l-brand bg-card px-5 py-4">
        <p className="max-w-[110ch] whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {placeholder ? (
            <span className="text-muted-foreground">Assessing pod status…</span>
          ) : (
            <>
              {staticText}
              {showLive &&
                (liveText ? (
                  <>{" "}{liveText}</>
                ) : (
                  <span className="text-muted-foreground">{" "}{pending}</span>
                ))}
            </>
          )}
        </p>
      </div>
    </div>
  )
}
