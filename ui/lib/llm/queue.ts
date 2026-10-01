import "server-only"

export const TIER = {
  podDiagnosisFocus: 300,
  podDiagnosisBackground: 200,
  actionFocus: 100,
  actionPrewarm: 0,
} as const

const JOB_TIMEOUT_MS = 300 * 1000
const JOB_ATTEMPTS = 2
const DEFER_WAIT_MAX_MS = 30 * 1000

export type JobKind = "action" | "pod-diagnosis"

export class DeferJob extends Error {
  until: number

  constructor(until: number) {
    super(`deferred until ${new Date(until).toISOString()}`)
    this.name = "DeferJob"
    this.until = until
  }
}

export type QueueJob = {
  kind: JobKind
  key: string
  tier: number
  seq: number
  order: number
  timeoutMs?: number
  run: (signal: AbortSignal) => Promise<void>
  onFailed: (reason: string) => void
}

type Job = QueueJob & { notBefore: number }
type State = { jobs: Job[]; focusCounter: number; running: boolean }

const STATE_KEY = Symbol.for("driftmower.llm-queue")

function state(): State {
  const g = globalThis as typeof globalThis & { [STATE_KEY]?: State }
  g[STATE_KEY] ??= { jobs: [], focusCounter: 0, running: false }
  return g[STATE_KEY]
}

function find(s: State, kind: JobKind, key: string): Job | undefined {
  return s.jobs.find(j => j.kind === kind && j.key === key)
}

export function nextFocusSeq(): number {
  return ++state().focusCounter
}

export function isQueued(kind: JobKind, key: string): boolean {
  return find(state(), kind, key) !== undefined
}

export function queuedCount(kind: JobKind): number {
  return state().jobs.filter(j => j.kind === kind).length
}

export function bump(kind: JobKind, key: string, tier: number, seq: number): void {
  const queued = find(state(), kind, key)
  if (!queued) return
  queued.tier = Math.max(queued.tier, tier)
  queued.seq = Math.max(queued.seq, seq)
}

export function enqueue(job: Omit<QueueJob, "seq"> & { seq?: number }): void {
  const s = state()
  const seq = job.seq ?? 0
  const queued = find(s, job.kind, job.key)
  if (queued) {
    queued.tier = Math.max(queued.tier, job.tier)
    queued.seq = Math.max(queued.seq, seq)
    queued.order = Math.min(queued.order, job.order)
  } else {
    s.jobs.push({ ...job, seq, notBefore: 0 })
  }
  void startWorker(s)
}

function pickNext(s: State, now: number): Job | undefined {
  let best = -1
  for (let i = 0; i < s.jobs.length; i++) {
    const a = s.jobs[i]
    if (a.notBefore > now) continue
    const b = best === -1 ? null : s.jobs[best]
    if (!b || a.tier > b.tier || (a.tier === b.tier && a.seq > b.seq) || (a.tier === b.tier && a.seq === b.seq && a.order < b.order)) best = i
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

export function failureReason(e: unknown, timeoutMs: number): string {
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
    return `model did not answer within ${Math.round(timeoutMs / 1000)} s`
  }
  const statusCode = (e as { statusCode?: unknown } | null)?.statusCode
  if (typeof statusCode === "number") return `model API returned ${statusCode}`
  const cause = (e as { cause?: { code?: unknown } } | null)?.cause?.code
  if (typeof cause === "string") return `model API unreachable (${cause})`
  return e instanceof Error ? e.message : String(e)
}

type Outcome = { state: "ready" | "failed" } | { state: "deferred"; until: number }

async function runJob(job: Job): Promise<Outcome> {
  let lastError: unknown
  for (let attempt = 1; attempt <= JOB_ATTEMPTS; attempt++) {
    try {
      await job.run(AbortSignal.timeout(job.timeoutMs ?? JOB_TIMEOUT_MS))
      return { state: "ready" }
    } catch (e) {
      if (e instanceof DeferJob) return { state: "deferred", until: e.until }
      lastError = e
    }
  }
  const reason = failureReason(lastError, job.timeoutMs ?? JOB_TIMEOUT_MS)
  console.warn(`[llm-queue] ${job.kind} ${job.key} failed: ${reason}`)
  job.onFailed(reason)
  return { state: "failed" }
}

async function startWorker(s: State): Promise<void> {
  if (s.running) return
  s.running = true
  try {
    for (let job = await waitForNext(s); job; job = await waitForNext(s)) {
      const started = Date.now()
      const outcome = await runJob(job)
      if (outcome.state === "deferred") {
        s.jobs.push({ ...job, notBefore: outcome.until })
        console.info(`[llm-queue] deferred ${job.kind} ${job.key} until ${new Date(outcome.until).toISOString()}`)
        continue
      }
      const ms = Date.now() - started
      console.info(`[llm-queue] ${outcome.state} ${job.kind} ${job.key} in ${(ms / 1000).toFixed(1)}s (queue ${s.jobs.length})`)
    }
  } finally {
    s.running = false
  }
}
