import { create } from "zustand"

const PROGRESS_KEY = "driftmower.connecting"
const PENDING_KEY = "driftmower.pending-connect"
const TIMEOUT_MS = 120_000

type ConnectionProgress = {
  target: string | null
  label: string | null
  operation: number
  error: string | null
  initiating: boolean
}

export const useConnectionProgress = create<ConnectionProgress>(() => ({
  target: null,
  label: null,
  operation: 0,
  error: null,
  initiating: false,
}))

let timer: ReturnType<typeof setTimeout> | undefined

function setProgress(target: string | null, started: number, initiating = false, label: string | null = null) {
  clearTimeout(timer)
  timer = undefined
  useConnectionProgress.setState(state => ({ target, label, operation: state.operation + 1, error: null, initiating }))
  if (target === null) {
    sessionStorage.removeItem(PROGRESS_KEY)
    sessionStorage.removeItem(PENDING_KEY)
    return
  }
  sessionStorage.setItem(PROGRESS_KEY, JSON.stringify({ target, label, started }))
  timer = setTimeout(() => {
    connectionProgress(null)
    useConnectionProgress.setState({ error: "Connection timed out. Try Connect again." })
  }, TIMEOUT_MS - (Date.now() - started))
}

export function connectionProgress(target: string | null, initiating = false, label: string | null = null) {
  // A new explicit choice supersedes any earlier pending desktop connection.
  sessionStorage.removeItem(PENDING_KEY)
  setProgress(target, Date.now(), initiating, label)
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
      setProgress(pending.target, pending.started, false, "label" in pending && typeof pending.label === "string" ? pending.label : null)
      return
    }
  }
  connectionProgress(null)
}
