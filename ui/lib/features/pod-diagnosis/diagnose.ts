import "server-only"

import { TIER, bump, enqueue, isQueued, nextFocusSeq, queuedCount } from "@/lib/llm/queue"
import { callDiagnosePrompt, type DiagnosisAnswer } from "@/lib/llm/prompts/diagnose-pod-failure"
import { buildDiagnosisPayload, collectDiagnosisInputs, type DiagnosisPayload } from "./payload"
import { checkText, commandsFor } from "./commands"
import { assessConfidence } from "./confidence"
import { PROMPT_VERSION, type DiagnosisFacts, type DiagnosisResult, type DiagnosisState, type Evidence } from "./types"

const STORE_IDLE_MS = 14 * 24 * 60 * 60 * 1000
const STORE_MAX = 2000
const FAILED_RETRY_MS = 5 * 60 * 1000
const STALE_MS = 6 * 60 * 60 * 1000
const FORCE_MIN_INTERVAL_MS = 60 * 1000
const QUEUE_CAP = 50

type StoreEntry = DiagnosisState & { lastSeenAt: number; forcedAt?: number }
type State = { store: Map<string, StoreEntry> }

const STATE_KEY = Symbol.for("driftmower.pod-diagnosis")

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

function needsWork(entry: StoreEntry | undefined, now: number, force: boolean): boolean {
  if (!entry) return true
  if (entry.state === "pending") return false
  if (force) return now - (entry.forcedAt ?? 0) > FORCE_MIN_INTERVAL_MS
  if (entry.state === "failed") return now - entry.computedAt > FAILED_RETRY_MS
  return now - entry.computedAt > STALE_MS
}

export function sync(pods: DiagnosisFacts[], focus: boolean, force: boolean): Record<string, DiagnosisState> {
  const s = state()
  const now = Date.now()
  sweep(s, now)
  const tier = focus ? TIER.podDiagnosisFocus : TIER.podDiagnosisBackground
  const seq = focus ? nextFocusSeq() : 0
  const results: Record<string, DiagnosisState> = {}

  pods.forEach((facts, order) => {
    const key = facts.key
    const existing = s.store.get(key)
    if (existing) existing.lastSeenAt = now

    if (needsWork(existing, now, force)) {
      if (!isQueued("pod-diagnosis", key) && queuedCount("pod-diagnosis") >= QUEUE_CAP) {
        if (existing) results[key] = existing
        return
      }
      const previous = existing?.state === "ready" ? existing : undefined
      s.store.set(key, {
        state: "pending",
        lastSeenAt: now,
        forcedAt: force ? now : existing?.forcedAt,
        ...(previous ? { result: previous.result, computedAt: previous.computedAt } : {}),
      })
      enqueue({
        kind: "pod-diagnosis",
        key,
        tier,
        seq,
        order,
        run: signal => runDiagnosis(facts, signal),
        onFailed: reason => storeFailed(facts, reason),
      })
    } else if (existing?.state === "pending" && focus) {
      bump("pod-diagnosis", key, tier, seq)
    }

    results[key] = s.store.get(key) ?? { state: "pending" }
  })

  return results
}

async function runDiagnosis(facts: DiagnosisFacts, signal: AbortSignal): Promise<void> {
  const inputs = await collectDiagnosisInputs(facts, signal)
  const payload = buildDiagnosisPayload(facts, inputs)
  const answer = await callDiagnosePrompt(payload, signal)
  storeSet(facts.key, { state: "ready", result: toResult(answer, facts, payload), computedAt: Date.now() })
}

function storeFailed(facts: DiagnosisFacts, reason: string): void {
  storeSet(facts.key, { state: "failed", result: fallbackResult(reason), computedAt: Date.now() })
}

function storeSet(key: string, value: DiagnosisState): void {
  const s = state()
  const existing = s.store.get(key)
  s.store.set(key, { ...value, lastSeenAt: existing?.lastSeenAt ?? Date.now(), forcedAt: existing?.forcedAt })
}

export function toResult(answer: DiagnosisAnswer, facts: DiagnosisFacts, payload: DiagnosisPayload): DiagnosisResult {
  const { kind, action } = answer.fix
  const evidence = resolveEvidence(answer.evidence, payload)
  const confidence = assessConfidence(answer, facts, payload, evidence)
  return {
    category: answer.category,
    cause: answer.cause,
    confidence: confidence.level,
    confidenceNote: confidence.note,
    evidence,
    fix: { kind, commands: commandsFor(kind, answer.fix, facts), action },
    check: checkText(kind, answer.fix, facts),
    since: payload.since,
  }
}

const LOG_RANGE_MAX_LINES = 5

type IndexedBlock = "status" | "spec" | "events" | "node" | "siblings" | "release" | "metrics"
type EvidenceSource = { block: IndexedBlock; kind: Evidence["kind"]; label: string; link: Evidence["link"] }

const SOURCES: Record<string, EvidenceSource> = {
  ST: { block: "status", kind: "status", label: "Pod status", link: "yaml" },
  S: { block: "spec", kind: "spec", label: "Pod spec", link: "yaml" },
  E: { block: "events", kind: "event", label: "Event", link: null },
  N: { block: "node", kind: "node", label: "Node", link: "node" },
  SB: { block: "siblings", kind: "siblings", label: "Siblings", link: "pods" },
  R: { block: "release", kind: "release", label: "Release", link: "pods" },
  M: { block: "metrics", kind: "metrics", label: "Metrics", link: null },
}

function logEvidence(blockIndex: number, lineIndex: number, payload: DiagnosisPayload): Evidence | null {
  const logBlock = payload.logs[blockIndex]
  const text = logBlock?.lines[lineIndex]
  return text ? { kind: "logs", label: `${logBlock.container} logs`, text, link: "logs" } : null
}

function lookup(index: string, payload: DiagnosisPayload): Evidence[] {
  const logRange = /^L(\d+)\.(\d+)(?:-(?:L?\d+\.)?(\d+))?$/.exec(index)
  if (logRange) {
    const blockIndex = Number(logRange[1])
    const first = Number(logRange[2])
    const last = logRange[3] === undefined ? first : Number(logRange[3])
    const count = Math.max(0, Math.min(last - first, LOG_RANGE_MAX_LINES - 1) + 1)
    return Array.from({ length: count }, (_, i) => logEvidence(blockIndex, first + i, payload)).filter((e): e is Evidence => e !== null)
  }

  const single = /^(ST|SB|S|E|N|R|M)(\d+)$/.exec(index)
  if (!single) return []
  const { block, ...source } = SOURCES[single[1]]
  const text = payload[block][Number(single[2])]
  return text ? [{ ...source, text }] : []
}

export function resolveEvidence(indices: string[], payload: DiagnosisPayload): Evidence[] {
  const out: Evidence[] = []
  for (const index of indices) {
    for (const evidence of lookup(index.trim(), payload)) {
      if (!out.some(e => e.text === evidence.text)) out.push(evidence)
    }
  }
  return out
}

export function fallbackResult(reason?: string): DiagnosisResult {
  return {
    category: null,
    cause: reason ? `Diagnosis unavailable: ${reason}` : "Diagnosis unavailable",
    confidence: "low",
    confidenceNote: "model did not answer",
    evidence: [],
    fix: { kind: "none", commands: [], action: "" },
    check: "",
    since: null,
  }
}
