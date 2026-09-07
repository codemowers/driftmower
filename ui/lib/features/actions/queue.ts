import "server-only"

import { PROMPT_VERSION, assessKey, type ActionFacts, type AssessState } from "@/lib/features/actions/types"
import { deterministicResult } from "@/lib/features/actions/verdict"
import { assess } from "./assess"

const STORE_IDLE_MS = 14 * 24 * 60 * 60 * 1000
const STORE_MAX = 2000
const FAILED_RETRY_MS = 5 * 60 * 1000
const JOB_TIMEOUT_MS = 300 * 1000
const JOB_ATTEMPTS = 2

type StoreEntry = AssessState & { lastSeenAt: number }
type Job = { key: string; facts: ActionFacts; priority: number; order: number }
type State = { store: Map<string, StoreEntry>; jobs: Job[]; focusCounter: number; running: boolean }

const STATE_KEY = Symbol.for("driftmower.actions")

function state(): State {
  const g = globalThis as typeof globalThis & { [STATE_KEY]?: State }
  g[STATE_KEY] ??= { store: new Map(), jobs: [], focusCounter: 0, running: false }
  return g[STATE_KEY]
}

function sweep(s: State, now: number): void {
  const prefix = `v${PROMPT_VERSION}:`
  for (const [key, entry] of s.store) {
    if (!key.startsWith(prefix) || now - entry.lastSeenAt > STORE_IDLE_MS) s.store.delete(key)
  }
  if (s.store.size > STORE_MAX) {
    const byAge = [...s.store.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)
    for (const [key] of byAge.slice(0, s.store.size - STORE_MAX)) s.store.delete(key)
  }
}

function needsWork(entry: StoreEntry | undefined, now: number): boolean {
  if (!entry) return true
  return entry.state === "failed" && now - entry.computedAt > FAILED_RETRY_MS
}

export function sync(actions: ActionFacts[], focus: boolean): Record<string, AssessState> {
  const s = state()
  const now = Date.now()
  sweep(s, now)
  const priority = focus ? ++s.focusCounter : 0
  const results: Record<string, AssessState> = {}

  actions.forEach((facts, order) => {
    const key = assessKey(facts)
    const existing = s.store.get(key)
    if (existing) existing.lastSeenAt = now

    if (facts.kind === "pin-digest") {
      const entry: StoreEntry = { state: "ready", result: deterministicResult(facts), computedAt: now, lastSeenAt: now }
      s.store.set(key, entry)
      results[key] = entry
      return
    }

    if (needsWork(existing, now)) {
      s.store.set(key, { state: "pending", lastSeenAt: now })
      const queued = s.jobs.find(j => j.key === key)
      if (queued) {
        queued.priority = Math.max(queued.priority, priority)
        queued.order = Math.min(queued.order, order)
      } else {
        s.jobs.push({ key, facts, priority, order })
      }
    } else if (existing?.state === "pending" && priority > 0) {
      const queued = s.jobs.find(j => j.key === key)
      if (queued) queued.priority = Math.max(queued.priority, priority)
    }

    results[key] = s.store.get(key) ?? { state: "pending" }
  })

  void startWorker(s)
  return results
}

function pickNext(s: State): Job | undefined {
  if (s.jobs.length === 0) return undefined
  let best = 0
  for (let i = 1; i < s.jobs.length; i++) {
    const a = s.jobs[i]
    const b = s.jobs[best]
    if (a.priority > b.priority || (a.priority === b.priority && a.order < b.order)) best = i
  }
  return s.jobs.splice(best, 1)[0]
}

async function runJob(job: Job): Promise<Exclude<AssessState, { state: "pending" }>> {
  let lastError: unknown
  for (let attempt = 1; attempt <= JOB_ATTEMPTS; attempt++) {
    try {
      const result = await assess(job.facts, AbortSignal.timeout(JOB_TIMEOUT_MS))
      return { state: "ready", result, computedAt: Date.now() }
    } catch (e) {
      lastError = e
    }
  }
  console.warn(`[actions] ${job.key} failed:`, (lastError as Error)?.message ?? lastError)
  return { state: "failed", result: deterministicResult(job.facts), computedAt: Date.now() }
}

async function startWorker(s: State): Promise<void> {
  if (s.running) return
  s.running = true
  try {
    for (let job = pickNext(s); job; job = pickNext(s)) {
      const started = Date.now()
      const outcome = await runJob(job)
      const existing = s.store.get(job.key)
      s.store.set(job.key, { ...outcome, lastSeenAt: existing?.lastSeenAt ?? started })
      console.info(`[actions] ${outcome.state} ${job.key} in ${((Date.now() - started) / 1000).toFixed(1)}s (queue ${s.jobs.length})`)
    }
  } finally {
    s.running = false
  }
}
