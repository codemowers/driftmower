import type { ImageUsage } from "@/lib/cluster/reports"
import type { VulnerabilityReport } from "@/lib/cluster/vulnerability/types"
import type { LiveFacts, PodSummaryKind, StaticFacts } from "./types"
import { PROMPT_VERSION } from "./prompts"
import { staticFacts } from "./precompute"

const ENDPOINT = "/api/llm/pod-summary"

const STORE_KEY = "dm:pod-summary"
type Store = Record<string, string>

function readStore(): Store {
  if (typeof window === "undefined") return {}
  try {
    return JSON.parse(window.localStorage.getItem(STORE_KEY) ?? "{}") as Store
  } catch {
    return {}
  }
}

function writeStore(store: Store): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(store))
  } catch {
    // ignore
  }
}

function staticKey(facts: StaticFacts): string {
  return `v${PROMPT_VERSION}:${JSON.stringify(facts)}`
}

const liveCache = new Map<string, string>()

export function getLiveText(podUid: string): string | null {
  return liveCache.get(podUid) ?? null
}

export function ensureLive(podUid: string, facts: LiveFacts): void {
  if (liveCache.has(podUid)) return
  liveCache.set(podUid, "")
  void (async () => {
    let text = ""
    try {
      for await (const chunk of streamLiveSummary(facts)) {
        text += chunk
        liveCache.set(podUid, text)
      }
    } catch {
      // ignore
    }
    if (!text) liveCache.delete(podUid)
  })()
}

async function* streamFromRoute(kind: PodSummaryKind, facts: StaticFacts | LiveFacts): AsyncIterable<string> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, facts }),
  })
  if (!res.ok || !res.body) throw new Error(`pod-summary ${kind} failed: ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    yield decoder.decode(value, { stream: true })
  }
}

export async function* streamStaticSummary(
  podUsages: ImageUsage[],
  vulnReports: Record<string, VulnerabilityReport> | null,
): AsyncIterable<string> {
  const facts = staticFacts(podUsages, vulnReports)
  const key = staticKey(facts)

  const cached = readStore()[key]
  if (cached !== undefined) {
    yield cached
    return
  }

  let text = ""
  for await (const chunk of streamFromRoute("static", facts)) {
    text += chunk
    yield chunk
  }
  if (text) {
    const store = readStore()
    store[key] = text
    writeStore(store)
  }
}

export async function* streamLiveSummary(facts: LiveFacts): AsyncIterable<string> {
  yield* streamFromRoute("live", facts)
}

// One at a time: these streams would otherwise hold the connections navigation needs.
export async function prewarmStaticSummaries(
  podUsagesList: ImageUsage[][],
  vulnReports: Record<string, VulnerabilityReport> | null,
): Promise<void> {
  const seen = new Set<string>()

  for (const usages of podUsagesList) {
    if (usages.length === 0) continue
    const key = staticKey(staticFacts(usages, vulnReports))
    if (seen.has(key) || readStore()[key] !== undefined) continue
    seen.add(key)
    try {
      for await (const chunk of streamStaticSummary(usages, vulnReports)) void chunk
    } catch {
      // ignore
    }
  }
}

