import { cn } from "@/lib/utils/cn"
import { deterministicResult } from "@/lib/features/actions/verdict"
import type { ActionRow, AssessResult, AssessState, DisplayRow, Risk, Value } from "@/lib/features/actions/types"

export type ChipState = Risk | "assessing" | "unassessed"

export const CHIP_STYLE: Record<ChipState, { label: string; className: string }> = {
  safe: { label: "Safe", className: "bg-status-ok-bg text-status-ok-label" },
  review: { label: "Review", className: "bg-status-minor-bg text-status-minor-label" },
  risky: { label: "Risky", className: "bg-status-major-bg text-status-major-label" },
  assessing: { label: "Assessing", className: "bg-status-neutral-bg text-status-neutral-label" },
  unassessed: { label: "—", className: "font-mono text-muted-foreground" },
}

export const RISK_RANK: Record<Risk, number> = { safe: 0, review: 1, risky: 2 }
export const VALUE_RANK: Record<Value, number> = { high: 0, medium: 1, low: 2 }

export type Assessed<T extends ActionRow = ActionRow> = { row: T; state: AssessState | undefined; result: AssessResult | null }

export type EnrichedRow<T extends ActionRow = ActionRow> = Assessed<DisplayRow<T>> & {
  absorbed: Assessed<T>[]
  chip: ChipState
  risk: Risk | null
  value: Value | null
}

export function resultOf(row: ActionRow, state: AssessState | undefined, unavailable: boolean): AssessResult | null {
  if (state && state.state !== "pending") return state.result
  return unavailable ? deterministicResult(row.facts) : null
}

export function chipState(state: AssessState | undefined, unavailable: boolean, result: AssessResult | null): ChipState {
  if (state?.state === "failed" || (unavailable && !state)) return result ? result.risk : "unassessed"
  if (!state || state.state === "pending") return unavailable ? "unassessed" : "assessing"
  return state.result.risk
}

function worstRisk(results: AssessResult[]): Risk | null {
  return results.reduce<Risk | null>((acc, r) => (acc === null || RISK_RANK[r.risk] > RISK_RANK[acc] ? r.risk : acc), null)
}

function bestValue(results: AssessResult[]): Value | null {
  return results.reduce<Value | null>((acc, r) => (acc === null || VALUE_RANK[r.value] < VALUE_RANK[acc] ? r.value : acc), null)
}

export function enrichRow<T extends ActionRow>(row: DisplayRow<T>, results: Record<string, AssessState>, unavailable: boolean): EnrichedRow<T> {
  const state = results[row.key]
  const result = resultOf(row, state, unavailable)
  const absorbed = row.absorbed.map(a => ({ row: a, state: results[a.key], result: resultOf(a, results[a.key], unavailable) }))
  const assessed = [result, ...absorbed.map(a => a.result)].filter((r): r is AssessResult => r !== null)
  const ownChip = chipState(state, unavailable, result)
  const risk = worstRisk(assessed)
  const chip: ChipState = row.waitingOnChart && !unavailable ? "assessing" : ownChip in RISK_RANK && risk ? risk : ownChip
  return { row, state, result, absorbed, chip, risk, value: bestValue(assessed) }
}

export function RiskChip({ state }: { state: ChipState }) {
  const style = CHIP_STYLE[state]
  return (
    <span className={cn("inline-flex h-6 min-w-[60px] items-center justify-center rounded-md px-2.5 text-[11px] font-semibold", style.className)}>
      {style.label}
    </span>
  )
}
