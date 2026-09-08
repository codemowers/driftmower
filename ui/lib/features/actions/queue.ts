import "server-only"

import { PROMPT_VERSION, assessKey, type ActionFacts, type AssessState } from "@/lib/features/actions/types"
import { deterministicResult } from "@/lib/features/actions/verdict"
import { assess } from "./assess"
import { GithubRateLimitedError, resolveChangelog } from "./changelog"

const STORE_IDLE_MS = 14 * 24 * 60 * 60 * 1000
const STORE_MAX = 2000
const FAILED_RETRY_MS = 5 * 60 * 1000
const JOB_TIMEOUT_MS = 300 * 1000
const JOB_ATTEMPTS = 2
const HISTORY_MAX = 40
const SNAPSHOT_ENTRIES_MAX = 200
const DEFER_WAIT_MAX_MS = 30 * 1000

type StoreEntry = AssessState & { lastSeenAt: number }
type Job = { key: string; facts: ActionFacts; priority: number; order: number; notBefore: number }
type Current = { key: string; startedAt: number }
type HistoryEntry = { key: string; state: "ready" | "failed"; ms: number; at: number }
type State = { store: Map<string, StoreEntry>; jobs: Job[]; focusCounter: number; running: boolean; current: Current | null; history: HistoryEntry[] }
type Outcome = Exclude<AssessState, { state: "pending" }> | { state: "deferred"; until: number }

export type QueueSnapshot = {
  now: number
  current: Current | null
  jobs: { key: string; priority: number; order: number; notBefore: number }[]
  history: HistoryEntry[]
  counts: { total: number; pending: number; ready: number; failed: number }
  entries: { key: string; state: AssessState["state"]; computedAt: number | null; lastSeenAt: number }[]
}

const STATE_KEY = Symbol.for("driftmower.actions")

function state(): State {
  const g = globalThis as typeof globalThis & { [STATE_KEY]?: State }
  g[STATE_KEY] ??= { store: new Map(), jobs: [], focusCounter: 0, running: false, current: null, history: [] }
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
        s.jobs.push({ key, facts, priority, order, notBefore: 0 })
        if (facts.kind === "upgrade-chart") void primeChartAppVersions(s, key, facts).catch(() => {})
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

async function primeChartAppVersions(s: State, key: string, facts: ActionFacts): Promise<void> {
  const changelog = await resolveChangelog(facts)
  const entry = s.store.get(key)
  if (entry?.state === "pending") s.store.set(key, { ...entry, chartAppVersions: changelog.chartAppVersions })
}

export function snapshot(): QueueSnapshot {
  const s = state()
  const counts = { total: s.store.size, pending: 0, ready: 0, failed: 0 }
  for (const entry of s.store.values()) counts[entry.state]++
  const entries = [...s.store.entries()]
    .sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt)
    .slice(0, SNAPSHOT_ENTRIES_MAX)
    .map(([key, entry]) => ({ key, state: entry.state, computedAt: entry.state === "pending" ? null : entry.computedAt, lastSeenAt: entry.lastSeenAt }))
  return {
    now: Date.now(),
    current: s.current,
    jobs: s.jobs.map(j => ({ key: j.key, priority: j.priority, order: j.order, notBefore: j.notBefore })),
    history: s.history,
    counts,
    entries,
  }
}

function pickNext(s: State, now: number): Job | undefined {
  let best = -1
  for (let i = 0; i < s.jobs.length; i++) {
    const a = s.jobs[i]
    if (a.notBefore > now) continue
    const b = best === -1 ? null : s.jobs[best]
    if (!b || a.priority > b.priority || (a.priority === b.priority && a.order < b.order)) best = i
  }
  return best === -1 ? undefined : s.jobs.splice(best, 1)[0]
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForNext(s: State): Promise<Job | undefined> {
  for (;;) {
    const now = Date.now()
    const job = pickNext(s, now)
    if (job || s.jobs.length === 0) return job
    const earliest = Math.min(...s.jobs.map(j => j.notBefore))
    await sleep(Math.min(Math.max(earliest - now, 0), DEFER_WAIT_MAX_MS))
  }
}

async function runJob(job: Job): Promise<Outcome> {
  let lastError: unknown
  for (let attempt = 1; attempt <= JOB_ATTEMPTS; attempt++) {
    try {
      const result = await assess(job.facts, AbortSignal.timeout(JOB_TIMEOUT_MS))
      return { state: "ready", result, computedAt: Date.now() }
    } catch (e) {
      if (e instanceof GithubRateLimitedError) return { state: "deferred", until: e.resetAt }
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
    for (let job = await waitForNext(s); job; job = await waitForNext(s)) {
      const started = Date.now()
      s.current = { key: job.key, startedAt: started }
      const outcome = await runJob(job)
      if (outcome.state === "deferred") {
        s.jobs.push({ ...job, notBefore: outcome.until })
        console.info(`[actions] deferred ${job.key} until ${new Date(outcome.until).toISOString()} (GitHub rate limit)`)
        continue
      }
      const existing = s.store.get(job.key)
      s.store.set(job.key, { ...outcome, lastSeenAt: existing?.lastSeenAt ?? started })
      const ms = Date.now() - started
      s.history.unshift({ key: job.key, state: outcome.state, ms, at: Date.now() })
      if (s.history.length > HISTORY_MAX) s.history.length = HISTORY_MAX
      console.info(`[actions] ${outcome.state} ${job.key} in ${(ms / 1000).toFixed(1)}s (queue ${s.jobs.length})`)
    }
  } finally {
    s.current = null
    s.running = false
  }
}
