import type { DiagnosisAnswer } from "@/lib/llm/prompts/diagnose-pod-failure"
import type { DiagnosisFacts, Evidence, FixKind } from "./types"
import type { FixSlots } from "./commands"
import type { DiagnosisPayload } from "./payload"
import { resolveService } from "./commands"

export type Confidence = "high" | "medium" | "low"

export type ConfidenceVerdict = { level: Confidence; note: string }

type Slot = keyof FixSlots
const REQUIRED_SLOTS: Partial<Record<FixKind, Slot[]>> = {
  config: ["ref"],
  resources: ["resource", "suggested"],
  image: ["image"],
  dependency: ["service"],
  spec: ["path", "suggested"],
  volume: ["ref"],
  rbac: ["ref"],
  namespace: ["ref"],
}

const DIRECT_EVIDENCE = new Set<Evidence["kind"]>(["logs", "event"])

function factsText(payload: DiagnosisPayload): string {
  return [
    ...payload.status,
    ...payload.spec,
    ...payload.events,
    ...payload.logs.flatMap(block => block.lines),
    ...payload.node,
    ...payload.siblings,
    ...payload.release,
    ...payload.metrics,
  ].join("\n").toLowerCase()
}

function slotInFacts(kind: FixKind, slot: Slot, value: string, facts: DiagnosisFacts, text: string): boolean {
  if (slot === "service") return resolveService(value, facts) !== null
  if (slot === "path") return true
  if (kind === "resources" && slot === "suggested") return true
  return text.includes(value.toLowerCase())
}

function rank(level: Confidence): number {
  return level === "high" ? 3 : level === "medium" ? 2 : 1
}

function lower(a: Confidence, b: Confidence): Confidence {
  return rank(a) <= rank(b) ? a : b
}

export function assessConfidence(answer: DiagnosisAnswer, facts: DiagnosisFacts, payload: DiagnosisPayload, evidence: Evidence[]): ConfidenceVerdict {
  const { kind } = answer.fix
  const text = factsText(payload)
  const hasDirectEvidence = evidence.some(e => DIRECT_EVIDENCE.has(e.kind))
  const hasLogsOrEvents = payload.logs.some(block => block.lines.length > 0) || payload.events.length > 0

  let level: Confidence = "high"
  let note = "no caveats"

  if (kind === "none") {
    if (!hasLogsOrEvents) {
      level = "low"
      note = "no logs or events to go on"
    } else if (!hasDirectEvidence) {
      level = "medium"
      note = "cause inferred from status alone"
    }
  } else {
    const required = REQUIRED_SLOTS[kind] ?? []
    const missing = required.filter(slot => !answer.fix[slot])
    const guessed = required.filter(slot => answer.fix[slot] && !slotInFacts(kind, slot, answer.fix[slot] as string, facts, text))
    if (missing.length > 0) {
      level = "medium"
      note = `fix is missing its ${missing.join(" and ")}`
    } else if (guessed.length > 0) {
      level = "medium"
      note = `${guessed[0]} ${answer.fix[guessed[0]]} is not in the facts`
    }
  }

  const modelLevel = answer.confidence
  if (rank(modelLevel) < rank(level)) {
    return { level: lower(level, modelLevel), note: answer.confidenceNote !== "no caveats" ? answer.confidenceNote : note }
  }
  return { level, note: level === "high" && answer.confidenceNote !== "no caveats" ? answer.confidenceNote : note }
}
