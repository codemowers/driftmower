import { create } from "zustand"
import { requestTarget } from "../http/request.ts"

const PROGRESS_KEY = "driftmower.connecting"
const PENDING_KEY = "driftmower.pending-connect"
const TIMEOUT_MS = 10_000

type ConnectionProgress = {
  target: string | null
  label: string | null
  operation: number
  error: string | null
  initiating: boolean
  phase: string | null
  endpoint: string | null
  started: number | null
}

export const useConnectionProgress = create<ConnectionProgress>(() => ({
  target: null,
  label: null,
  operation: 0,
  error: null,
  initiating: false,
  phase: null,
  endpoint: null,
  started: null,
}))

let timer: ReturnType<typeof setTimeout> | undefined

function setProgress(target: string | null, started: number, initiating = false, label: string | null = null, phase = "discovering the selected connection", endpoint: string | null = null) {
  clearTimeout(timer)
  timer = undefined
  useConnectionProgress.setState(state => ({ target, label, operation: state.operation + 1, error: null, initiating, phase:target ? phase : null, endpoint:target && endpoint ? requestTarget(endpoint) : null, started:target ? started : null }))
  if (target === null) {
    sessionStorage.removeItem(PROGRESS_KEY)
    sessionStorage.removeItem(PENDING_KEY)
    return
  }
  sessionStorage.setItem(PROGRESS_KEY, JSON.stringify({ target, label, started, phase, endpoint:endpoint ? requestTarget(endpoint) : null }))
  timer = setTimeout(() => {
    const state = useConnectionProgress.getState()
    const context = state.label || (state.target && /^https?:\/\//.test(state.target) ? requestTarget(state.target) : "the selected context")
    const where = state.endpoint ? ` (${state.endpoint})` : ""
    const error = `Connection to ${context} timed out after ${Math.round((Date.now() - started) / 1000)} seconds while ${state.phase || "connecting"}${where}. Open Settings and retry Connect for ${context}.`
    connectionProgress(null)
    useConnectionProgress.setState({ error })
  }, TIMEOUT_MS - (Date.now() - started))
}

export function connectionProgress(target: string | null, initiating = false, label: string | null = null) {
  // A new explicit choice supersedes any earlier pending desktop connection.
  sessionStorage.removeItem(PENDING_KEY)
  setProgress(target, Date.now(), initiating, label)
}

// Ignore late updates from a connection the person has already replaced.
export function connectionStage(phase: string, endpoint?: string, operation = useConnectionProgress.getState().operation) {
  const state = useConnectionProgress.getState()
  if (!state.target || state.operation !== operation) return
  const safeEndpoint = endpoint ? requestTarget(endpoint) : null
  useConnectionProgress.setState({ phase, endpoint:safeEndpoint })
  sessionStorage.setItem(PROGRESS_KEY, JSON.stringify({ target:state.target, label:state.label, started:state.started, phase, endpoint:safeEndpoint }))
}

export function restoreConnectionProgress() {
  const raw = sessionStorage.getItem(PROGRESS_KEY)
  if (!raw) return
  let pending: unknown
  try {
    pending = JSON.parse(raw)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    connectionProgress(null)
    return
  }
  if (pending && typeof pending === "object" && "target" in pending && "started" in pending &&
      typeof pending.target === "string" && pending.target.trim() !== "" &&
      typeof pending.started === "number" && Number.isFinite(pending.started)) {
    const age = Date.now() - pending.started
    if (age >= 0 && age < TIMEOUT_MS) {
      setProgress(pending.target, pending.started, false, "label" in pending && typeof pending.label === "string" ? pending.label : null, "phase" in pending && typeof pending.phase === "string" ? pending.phase : undefined, "endpoint" in pending && typeof pending.endpoint === "string" ? pending.endpoint : null)
      return
    }
  }
  connectionProgress(null)
}
