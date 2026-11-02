"use client"

import { useEffect, useState } from "react"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import { buildInsightDetails, fetchAiInsights, type AiInsights, type InsightDetails } from "@/lib/features/ai-insights"

type Props = {
  workloadKey: string
  reportId: string | null
}

type State =
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "ready"; insights: AiInsights | null }

const CONFIDENCE_FILL: Record<string, number> = { low: 1, medium: 2, high: 3 }

function capitalize(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return "—"
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

function isUnknown(value: string): boolean {
  return value.trim().toLowerCase() === "unknown"
}

function SectionLabel() {
  return (
    <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      AI Insight
    </p>
  )
}

function StatLabel({ children }: { children: string }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  const unknown = isUnknown(value)
  return (
    <div className="flex flex-col gap-1.5 px-6 py-5">
      <StatLabel>{label}</StatLabel>
      <p className={cn("text-base font-semibold", unknown ? "text-muted-foreground" : "text-foreground")}>
        {capitalize(value)}
      </p>
    </div>
  )
}

function ConfidenceStat({ confidence }: { confidence: string }) {
  const fill = CONFIDENCE_FILL[confidence.trim().toLowerCase()] ?? 0
  return (
    <div className="flex flex-col gap-1.5 px-6 py-5">
      <StatLabel>Confidence</StatLabel>
      <div className="flex items-center gap-2">
        <span className={cn("text-base font-semibold", fill > 0 ? "text-foreground" : "text-muted-foreground")}>
          {capitalize(confidence)}
        </span>
        <div className="flex items-center gap-1">
          {[0, 1, 2].map(i => (
            <span key={i} className={cn("size-1.5 rounded-full", i < fill ? "bg-brand" : "bg-gray-300")} />
          ))}
        </div>
      </div>
    </div>
  )
}

function WhyThisLabel({ details }: { details: InsightDetails }) {
  const [expanded, setExpanded] = useState(false)
  const { summary, signals } = details

  return (
    <div className="border-t border-gray-200 px-6 py-4">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
        className="flex items-center gap-1.5 text-sm font-medium text-foreground"
      >
        <ChevronRight className={cn("size-4 text-muted-foreground transition-transform", expanded && "rotate-90")} />
        Why this label?
      </button>

      {expanded && (
        <div className="mt-3 flex flex-col gap-4">
          {summary && <p className="text-sm text-muted-foreground">{summary}</p>}

          {signals.length > 0 && (
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                What the classifier saw
              </p>
              <dl className="flex flex-col gap-1.5">
                {signals.map((signal, i) => (
                  <div key={i} className="flex gap-3 text-xs">
                    <dt className="w-24 shrink-0 font-mono text-muted-foreground">{signal.key || "—"}</dt>
                    <dd className="min-w-0">
                      <span className="break-all font-mono text-foreground">{signal.value}</span>
                      {signal.note && <span className="block text-muted-foreground">{capitalize(signal.note)}</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <SectionLabel />
      {children}
    </div>
  )
}

export default function AiInsightsCard({ workloadKey, reportId }: Props) {
  const [state, setState] = useState<State>({ phase: "loading" })

  useEffect(() => {
    if (!reportId) return
    let active = true
    fetchAiInsights(workloadKey, reportId)
      .then(insights => { if (active) setState({ phase: "ready", insights }) })
      .catch(() => { if (active) setState({ phase: "error" }) })
    return () => { active = false }
  }, [workloadKey, reportId])

  if (!reportId) return null

  if (state.phase === "loading") return null

  if (state.phase === "error") {
    return (
      <Frame>
        <div className="rounded-xl border border-gray-200 bg-white px-6 py-5 text-sm text-muted-foreground">
          Could not load AI analysis.
        </div>
      </Frame>
    )
  }

  if (state.insights === null) return null

  const { role, importance, confidence } = state.insights
  const details = buildInsightDetails(state.insights)

  return (
    <Frame>
      <div className="rounded-xl border border-gray-200 bg-white">
        <div className="grid grid-cols-3 divide-x divide-gray-200">
          <Stat label="Role" value={role} />
          <Stat label="Importance" value={importance} />
          <ConfidenceStat confidence={confidence} />
        </div>
        <WhyThisLabel details={details} />
      </div>
    </Frame>
  )
}
