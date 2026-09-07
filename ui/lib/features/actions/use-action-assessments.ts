"use client"

import { useEffect, useMemo, useState } from "react"
import { relateRows } from "./derive"
import { postAssessAll, recallResults, rememberResults } from "./client"
import type { ActionRow, AssessState, DisplayRow } from "./types"

const POLL_INTERVAL = 4000

export type ActionAssessments<T extends ActionRow = ActionRow> = {
  rows: T[]
  displayRows: DisplayRow<T>[]
  results: Record<string, AssessState>
  unavailable: boolean
}

type Options = { focus?: boolean }

export function useActionAssessments<T extends ActionRow>(rows: T[], currentCharts: ReadonlySet<string>, options: Options = {}): ActionAssessments<T> {
  const focus = options.focus ?? true
  const rowsKey = rows.map(r => r.key).join("\n")
  const [fresh, setResults] = useState<Record<string, AssessState>>({})
  const [unavailable, setUnavailable] = useState(false)
  const results = useMemo(() => ({ ...recallResults(rows), ...fresh }), [rows, fresh])
  const displayRows = useMemo(() => relateRows(rows, results, currentCharts), [rows, results, currentCharts])

  useEffect(() => {
    if (rows.length === 0) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    async function tick(first: boolean) {
      const outcome = await postAssessAll(rows.map(r => r.facts), first && focus).catch(() => null)
      if (cancelled) return
      if (outcome === "unavailable") {
        setUnavailable(true)
        return
      }
      if (outcome) {
        rememberResults(outcome.results)
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
  }, [rowsKey, focus])

  return { rows, displayRows, results, unavailable }
}
