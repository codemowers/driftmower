"use client"

import { useEffect, useState } from "react"
import { callTool } from "@/browser/connection"

export type PriorityClass = { name: string; value: number; description: string | null }

// Shared by every chip on a page and re-read after a minute.
let request: Promise<PriorityClass[]> | undefined
function load() {
  if (!request) {
    request = callTool<{ priorityClasses: PriorityClass[] }>("list_priority_classes").then(r => r.priorityClasses)
    void request.catch(() => undefined).finally(() => setTimeout(() => { request = undefined }, 60_000))
  }
  return request
}

export function usePriorityClasses(): { classes?: PriorityClass[]; error?: string } {
  const [state, setState] = useState<{ classes?: PriorityClass[]; error?: string }>({})
  useEffect(() => {
    let cancelled = false
    load()
      .then(classes => { if (!cancelled) setState({ classes }) })
      .catch((e: unknown) => { if (!cancelled) setState({ error: e instanceof Error ? e.message : String(e) }) })
    return () => { cancelled = true }
  }, [])
  return state
}
