import { z } from "zod"
import type { ActionFacts, Affect, ChangeEntry, Classification, ConfigKey } from "@/lib/features/actions/types"
import { queryObject } from "../query"

const NOTABLE_CAP = 4
const AFFECTS_CAP = 6
const PROMPT_ENTRY_MAX_CHARS = 120

type PayloadEntry = {
  index: number
  version: string
  text: string
  hint: "breaking" | "security" | null
}

type PayloadConfigKey = {
  index: number
  path: string
  type: string
}

export type Pretags = { breaking: number[]; security: number[] }

export type AssessPayload = {
  component: string
  from: string
  to: string
  entries: PayloadEntry[]
  config: PayloadConfigKey[]
}

function promptText(text: string): string {
  return text.length > PROMPT_ENTRY_MAX_CHARS ? `${text.slice(0, PROMPT_ENTRY_MAX_CHARS - 1).trimEnd()}…` : text
}

export function buildAssessPayload(facts: ActionFacts, entries: ChangeEntry[], configKeys: ConfigKey[], pretags: Pretags): AssessPayload {
  return {
    component: facts.repository,
    from: facts.from,
    to: facts.to,
    entries: entries.map((entry, index) => ({
      index,
      version: entry.version,
      text: promptText(entry.text),
      hint: pretags.breaking.includes(index) ? "breaking" : pretags.security.includes(index) ? "security" : null,
    })),
    config: configKeys.map((key, index) => ({ index, path: key.path, type: key.type })),
  }
}

function renderUserPrompt(payload: AssessPayload): string {
  const lines = [`component: ${payload.component}`, `from: ${payload.from}`, `to: ${payload.to}`, "", "entries:"]
  let lastVersion: string | null = null
  for (const entry of payload.entries) {
    if (entry.version !== lastVersion) {
      lines.push(entry.version)
      lastVersion = entry.version
    }
    lines.push(`${entry.index} ${entry.text}${entry.hint ? ` [${entry.hint}]` : ""}`)
  }
  lines.push("", "config:")
  if (payload.config.length === 0) lines.push("(none)")
  for (const key of payload.config) lines.push(`${key.index} ${key.path}: ${key.type}`)
  return lines.join("\n")
}

const looseList = z.array(z.unknown()).catch([])

const classificationSchema = z.object({
  breaking: looseList,
  security: looseList,
  notable: looseList,
  affects: looseList,
})

function indexList(value: unknown[], max: number): number[] {
  const out: number[] = []
  for (const v of value) {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN
    if (Number.isInteger(n) && n >= 0 && n < max && !out.includes(n)) out.push(n)
  }
  return out
}

function normalize(raw: z.infer<typeof classificationSchema>, entryCount: number, keyCount: number): Classification {
  const affects: Affect[] = []
  for (const pair of raw.affects) {
    if (!Array.isArray(pair) || pair.length !== 3) continue
    const [entry] = indexList([pair[0]], entryCount)
    const [config] = indexList([pair[1]], keyCount)
    const effect = pair[2] === "breaks" || pair[2] === "changes" ? pair[2] : null
    if (entry === undefined || config === undefined || !effect) continue
    if (affects.some(a => a.entry === entry && a.config === config)) continue
    affects.push({ entry, config, effect })
  }
  affects.sort((a, b) => Number(b.effect === "breaks") - Number(a.effect === "breaks"))
  return {
    breaking: indexList(raw.breaking, entryCount),
    security: indexList(raw.security, entryCount),
    notable: indexList(raw.notable, entryCount).slice(0, NOTABLE_CAP),
    affects: affects.slice(0, AFFECTS_CAP),
  }
}

export async function callAssessPrompt(payload: AssessPayload, abortSignal: AbortSignal): Promise<Classification> {
  const raw = await queryObject({
    model: "qwen3.6-classify",
    systemPrompt: `You classify software release notes for a Kubernetes operator deciding
      whether to upgrade. You receive numbered release-note entries between two versions
      of one component, and numbered configuration keys the operator has set for it.

      Answer with one JSON object on one line and nothing else:
      {"breaking":[entry indices],"security":[entry indices],"notable":[entry indices],
      "affects":[[entry index, config index, "breaks"|"changes"]]}

      RULES
      - breaking: the entry removes, renames, or changes the meaning of something a user
        may depend on (flags, keys, defaults, APIs, formats, storage). Include entries the
        source already marks as breaking.
      - security: the entry fixes a vulnerability or hardens against one.
      - notable: at most ${NOTABLE_CAP} other entries a platform engineer would want to know
        about, chosen from the whole list by importance, not position. Exclude entries
        already in breaking or security, and dependency bumps, docs, refactors, tests.
      - affects: at most ${AFFECTS_CAP} pairs, "breaks" first. Pair an entry with a config key
        only when the entry names that key, the flag it maps to, or one of its values; a
        shared topic is not enough. "breaks" when the key must change for the upgrade to
        work or keeps working differently; "changes" when the key is involved but nothing
        must change.
      - Order every list most important first.
      - Use only the entries given. Do not add text. If a list is empty, return [].`,
    userPrompt: renderUserPrompt(payload),
    schema: classificationSchema,
    abortSignal,
  })
  return normalize(raw, payload.entries.length, payload.config.length)
}
