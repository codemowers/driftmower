import type { AiInsights, InsightDetails, ParsedEvidence } from "./types"

export function parseEvidence(refs: string[]): ParsedEvidence {
  const signals: ParsedEvidence["signals"] = []
  const rules: string[] = []

  for (const ref of refs) {
    const dashIndex = ref.indexOf(" - ")
    const head = dashIndex === -1 ? ref : ref.slice(0, dashIndex)
    const note = dashIndex === -1 ? undefined : ref.slice(dashIndex + 3)

    const colonIndex = head.indexOf(":")
    const key = colonIndex === -1 ? "" : head.slice(0, colonIndex)
    const value = colonIndex === -1 ? head : head.slice(colonIndex + 1)

    if (key === "rule") {
      rules.push(value)
    } else {
      signals.push({ key, value, note })
    }
  }

  return { signals, rules }
}

export function buildInsightDetails(insights: AiInsights): InsightDetails {
  const { signals } = parseEvidence(insights.evidenceRefs)
  return {
    summary: insights.explanation?.trim() ?? "",
    signals,
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export function normalizeAiInsights(raw: unknown): AiInsights | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null
  const fields = raw as Record<string, unknown>
  const refs = Array.isArray(fields.evidenceRefs) ? fields.evidenceRefs : []
  return {
    role: text(fields.role),
    importance: text(fields.importance),
    confidence: text(fields.confidence),
    explanation: text(fields.explanation),
    evidenceRefs: refs.filter((ref): ref is string => typeof ref === "string"),
  }
}
