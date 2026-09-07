"use client"

import { useEffect, useRef, useState } from "react"
import { fetchLogs } from "@/lib/features/logs/fetch"
import { BUFFER_CAP, POLL_INTERVAL_MS, TAIL_LINES } from "@/lib/features/logs/constants"
import { compareNs } from "@/lib/features/logs/line"
import type { LogLine, LogSource } from "@/lib/features/logs/types"

export type LogsState = {
  lines: LogLine[]
  source: LogSource | null
  error: string | null
}

const INITIAL: LogsState = { lines: [], source: null, error: null }

export function useLogs(
  ns: string,
  pod: string,
  uid: string,
  container: string | undefined,
  follow: boolean,
): LogsState {
  const [state, setState] = useState<LogsState>(INITIAL)

  const followRef = useRef(follow)
  useEffect(() => {
    followRef.current = follow
  }, [follow])

  const key = `${ns}/${pod}/${container ?? "*"}`
  const [prevKey, setPrevKey] = useState(key)
  if (prevKey !== key) {
    setPrevKey(key)
    setState(INITIAL)
  }

  useEffect(() => {
    let cancelled = false
    let cursor: string | null = null
    let buffer: LogLine[] = []
    let source: LogSource | null = null
    const seen = new Set<string>()

    async function tick() {
      const resp = await fetchLogs({
        ns,
        pod,
        uid,
        container,
        sinceNs: cursor,
        limit: TAIL_LINES,
        sourceHint: source,
      }).catch(() => null)
      if (cancelled) return

      if (!resp) {
        setState(s => (s.error ? s : { ...s, error: "log source unreachable" }))
        return
      }
      source = resp.source

      let changed = false
      for (const line of resp.lines) {
        if (seen.has(line.key)) continue
        seen.add(line.key)
        buffer.push(line)
        changed = true
        if (cursor === null || compareNs(line.tsNs, cursor) > 0) cursor = line.tsNs
      }

      if (followRef.current && buffer.length > BUFFER_CAP) {
        const drop = buffer.length - BUFFER_CAP
        for (let i = 0; i < drop; i++) seen.delete(buffer[i].key)
        buffer = buffer.slice(drop)
        changed = true
      }

      setState(s => {
        if (!changed && s.source === source && s.error === null) return s
        return { lines: buffer.slice(), source, error: null }
      })
    }

    void tick()
    const id = setInterval(tick, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [ns, pod, uid, container])

  return state
}
