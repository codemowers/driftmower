import { create } from "zustand"

export type InspectedRequest = {
  id: number
  kind: "tool" | "http"
  // Tool name or request path.
  name: string
  args?: Record<string, unknown>
  method?: string
  body?: string
  page: string
  startedAt: number
  durationMs?: number
  status?: string
  // Uncompressed response size in bytes.
  bytes?: number
  response?: unknown
  error?: string
}

const FLAG = "driftmower.inspect"
const LIMIT = 300

function flag(): boolean {
  try { return sessionStorage.getItem(FLAG) === "true" } catch { return false }
}

type State = { enabled: boolean; open: boolean; requests: InspectedRequest[] }
export const useInspector = create<State>(() => ({ enabled: typeof window !== "undefined" && flag(), open: false, requests: [] }))

// Turning the inspector on reloads the page so every request of the view is
// recorded from the start; turning it off reloads to stop recording.
export function setInspecting(enabled: boolean) {
  try { if (enabled) sessionStorage.setItem(FLAG, "true"); else sessionStorage.removeItem(FLAG) } catch { /* Recording stays off without session storage. */ }
  location.reload()
}

let next = 1
// Records one request; returns a callback that completes it. Without the
// inspector it does nothing and keeps nothing.
export function inspect(start: Omit<InspectedRequest, "id" | "page" | "startedAt">): (end: Pick<InspectedRequest, "status" | "bytes" | "response" | "error">) => void {
  if (!useInspector.getState().enabled) return () => {}
  const entry: InspectedRequest = { ...start, id: next++, page: location.pathname + location.search, startedAt: performance.now() }
  useInspector.setState(state => ({ requests: [...state.requests, entry].slice(-LIMIT) }))
  return end => useInspector.setState(state => ({
    requests: state.requests.map(r => r.id === entry.id ? { ...r, ...end, durationMs: performance.now() - entry.startedAt } : r),
  }))
}

export function inspecting(): boolean {
  return useInspector.getState().enabled
}
