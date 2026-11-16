"use client"

import { useCallback, useEffect, useState } from "react"
import { poll } from "../queries/poll"

// Component-local query state, not a response cache. Callers own their keys,
// transport, authorization and error presentation. Keep load stable with useCallback.
export function useQuery<T>({ key, load, interval = 0, keepDataOnError = true }: {
  key: string | null
  load: (signal: AbortSignal) => Promise<T>
  interval?: number
  keepDataOnError?: boolean
}) {
  const [result, setResult] = useState<{ key: string; data?: T; error?: string }>()
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => { setResult(undefined); setAttempt(value => value + 1) }, [])
  useEffect(() => {
    if (key === null) return
    return poll({ load, interval,
      receive: data => setResult({ key, data }),
      fail: error => setResult(previous => ({ key,
        data: keepDataOnError && previous?.key === key ? previous.data : undefined,
        error: error instanceof Error ? error.message : String(error),
      })),
    })
  }, [key, load, interval, keepDataOnError, attempt])
  const current = key !== null && result?.key === key ? result : undefined
  return { data: current?.data, error: current?.error, loading: key !== null && !current, retry }
}
