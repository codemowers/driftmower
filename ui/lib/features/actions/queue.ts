import "server-only"

import { PROMPT_VERSION, assessKey, type ActionFacts, type AssessState } from "@/lib/features/actions/types"
import { deterministicResult } from "@/lib/features/actions/verdict"
import { DeferJob, TIER, enqueue, isQueued, nextFocusSeq, bump } from "@/lib/llm/queue"
import { assess } from "./assess"
import { GithubRateLimitedError, resolveChangelog } from "./changelog"

const STORE_IDLE_MS = 14 * 24 * 60 * 60 * 1000
const STORE_MAX = 2000
const FAILED_RETRY_MS = 5 * 60 * 1000

type StoreEntry = AssessState & { lastSeenAt: number }
type State = { store: Map<string, StoreEntry> }

const STATE_KEY = Symbol.for("driftmower.actions")

function state(): State {
  const g = globalThis as typeof globalThis & { [STATE_KEY]?: State }
  g[STATE_KEY] ??= { store: new Map() }
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
  const tier = focus ? TIER.actionFocus : TIER.actionPrewarm
  const seq = focus ? nextFocusSeq() : 0
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
      const alreadyQueued = isQueued("action", key)
      enqueue({ kind: "action", key, tier, seq, order, run: signal => runAssess(key, facts, signal), onFailed: () => storeFailed(key, facts) })
      if (!alreadyQueued && facts.kind === "upgrade-chart") void primeChartAppVersions(s, key, facts).catch(() => {})
    } else if (existing?.state === "pending" && tier > 0) {
      bump("action", key, tier, seq)
    }

    results[key] = s.store.get(key) ?? { state: "pending" }
  })

  return results
}

async function runAssess(key: string, facts: ActionFacts, signal: AbortSignal): Promise<void> {
  try {
    const result = await assess(facts, signal)
    storeSet(key, { state: "ready", result, computedAt: Date.now() })
  } catch (e) {
    if (e instanceof GithubRateLimitedError) throw new DeferJob(e.resetAt)
    throw e
  }
}

function storeFailed(key: string, facts: ActionFacts): void {
  storeSet(key, { state: "failed", result: deterministicResult(facts), computedAt: Date.now() })
}

function storeSet(key: string, value: AssessState): void {
  const s = state()
  const existing = s.store.get(key)
  s.store.set(key, { ...value, lastSeenAt: existing?.lastSeenAt ?? Date.now() })
}

async function primeChartAppVersions(s: State, key: string, facts: ActionFacts): Promise<void> {
  const changelog = await resolveChangelog(facts)
  const entry = s.store.get(key)
  if (entry?.state === "pending") s.store.set(key, { ...entry, chartAppVersions: changelog.chartAppVersions })
}
