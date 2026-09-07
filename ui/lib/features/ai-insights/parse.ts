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
