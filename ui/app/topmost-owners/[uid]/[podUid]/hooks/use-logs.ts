"use client"

import { useEffect, useRef, useState } from "react"
import { fetchLogs } from "@/lib/features/logs/fetch"
import { BUFFER_CAP, POLL_INTERVAL_MS, TAIL_LINES } from "@/lib/features/logs/constants"
import { compareNs } from "@/lib/features/logs/line"
import type { LogLine, LogSource } from "@/lib/features/logs/types"

export type LogsState = {
  lines: LogLine[]
  source: LogSource | null
  selector: "labels" | "pods" | "namespace" | null
  containers: string[]
  error: string | null
  notice: string | null
  loaded: boolean
}

const INITIAL: LogsState = { lines: [], source: null, selector: null, containers: [], error: null, notice: null, loaded: false }

// Polls a workload's logs, or one Pod's, from the newest line seen onward.
export function useLogs(namespace: string, workloadUid: string | undefined, pod: string | undefined, container: string | undefined, follow: boolean): LogsState {
  const [state, setState] = useState<LogsState>(INITIAL)

  const followRef = useRef(follow)
  useEffect(() => {
    followRef.current = follow
  }, [follow])

  const key = `${namespace}/${workloadUid}/${pod ?? "*"}/${container ?? "*"}`
  const [prevKey, setPrevKey] = useState(key)
  if (prevKey !== key) {
    setPrevKey(key)
    setState(INITIAL)
  }

  useEffect(() => {
    let cancelled = false
    let cursor: string | null = null
    let buffer: LogLine[] = []
    const seen = new Set<string>()

    async function tick() {
      const resp = await fetchLogs({ namespace, workloadUid, pod, container, sinceNs: cursor, limit: TAIL_LINES }).catch((e: Error) => e)
      if (cancelled) return
      if (resp instanceof Error) {
        const message = `Could not load logs: ${resp.message}`
        setState(s => (s.error === message ? s : { ...s, error: message }))
        return
      }

      let changed = false
      for (const line of resp.lines) {
        if (seen.has(line.key)) continue
        seen.add(line.key)
        buffer.push(line)
        changed = true
        if (cursor === null || compareNs(line.tsNs, cursor) > 0) cursor = line.tsNs
      }
      if (changed) buffer.sort((a, b) => compareNs(a.tsNs, b.tsNs))
      if (followRef.current && buffer.length > BUFFER_CAP) {
        const drop = buffer.length - BUFFER_CAP
        for (let i = 0; i < drop; i++) seen.delete(buffer[i].key)
        buffer = buffer.slice(drop)
        changed = true
      }

      const notice = resp.warnings.join(" ") || null
      setState(s => {
        if (!changed && s.loaded && s.source === resp.source && s.error === null && s.notice === notice) return s
        return {
          lines: buffer.slice(), source: resp.source, selector: resp.selector,
          containers: resp.containers.length ? resp.containers : s.containers, error: null, notice, loaded: true,
        }
      })
    }

    void tick()
    const id = setInterval(tick, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [namespace, workloadUid, pod, container])

  return state
}
