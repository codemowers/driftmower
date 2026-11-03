"use client"

import { useEffect, useRef, useState } from "react"
import { fetchLogs } from "@/lib/features/logs/fetch"
import { BUFFER_CAP, POLL_INTERVAL_MS, TAIL_LINES } from "@/lib/features/logs/constants"
import { compareNs } from "@/lib/features/logs/line"
import type { LogLine, LogSource, LogsResponse } from "@/lib/features/logs/types"

export type LogsState = {
  lines: LogLine[]
  source: LogSource | null
  error: string | null
  notice: string | null
  loaded: boolean
}

const INITIAL: LogsState = { lines: [], source: null, error: null, notice: null, loaded: false }

export function useLogs(
  ns: string,
  pod: string,
  uid: string,
  container: string | undefined,
  follow: boolean,
  includePrevious: boolean,
): LogsState {
  const [state, setState] = useState<LogsState>(INITIAL)

  const followRef = useRef(follow)
  useEffect(() => {
    followRef.current = follow
  }, [follow])

  const key = `${ns}/${pod}/${container ?? "*"}/${includePrevious}`
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
    let notice: string | null = null
    const seen = new Set<string>()

    function absorb(lines: LogLine[]): boolean {
      let changed = false
      for (const line of lines) {
        if (seen.has(line.key)) continue
        seen.add(line.key)
        buffer.push(line)
        changed = true
        if (cursor === null || compareNs(line.tsNs, cursor) > 0) cursor = line.tsNs
      }
      return changed
    }

    async function previousRun(): Promise<LogsResponse | null> {
      return fetchLogs({ ns, pod, uid, container, sinceNs: null, limit: TAIL_LINES, sourceHint: "kube API", previous: true }).catch(() => null)
    }

    async function tick() {
      const initial = cursor === null
      const resp = await fetchLogs({
        ns,
        pod,
        uid,
        container,
        sinceNs: cursor,
        limit: TAIL_LINES,
        sourceHint: source,
      }).catch((e: Error) => e)
      if (cancelled) return

      if (resp instanceof Error) {
        const message = `Could not load logs: ${resp.message}`
        setState(s => (s.error === message ? s : { ...s, error: message }))
        return
      }
      source = resp.source

      let changed = false
      if (initial && includePrevious && resp.source === "kube API") {
        const prev = await previousRun()
        if (cancelled) return
        if (prev) {
          changed = absorb(prev.lines)
          notice = prev.notice ?? null
        }
      }
      if (resp.notice) notice = resp.notice
      if (absorb(resp.lines)) changed = true
      if (changed) buffer.sort((a, b) => compareNs(a.tsNs, b.tsNs))

      if (followRef.current && buffer.length > BUFFER_CAP) {
        const drop = buffer.length - BUFFER_CAP
        for (let i = 0; i < drop; i++) seen.delete(buffer[i].key)
        buffer = buffer.slice(drop)
        changed = true
      }

      setState(s => {
        if (!changed && s.loaded && s.source === source && s.error === null) return s
        return { lines: buffer.slice(), source, error: null, notice, loaded: true }
      })
    }

    void tick()
    const id = setInterval(tick, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [ns, pod, uid, container, includePrevious])

  return state
}
