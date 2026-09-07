"use client"

import { useState } from "react"
import { ChevronRight, ExternalLink } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import CopyButton from "@/app/components/copy-button"
import { commandsFor } from "@/lib/features/actions/derive"
import { deterministicResult, reasonLine, VALUE_LEAD, VERDICT_LEAD } from "@/lib/features/actions/verdict"
import type { ActionRow, AssessResult, AssessState, HowCommand, Risk } from "@/lib/features/actions/types"
import type { ActionAssessments } from "../hooks/use-action-assessments"

const VISIBLE_ROWS = 4
const VISIBLE_BULLETS = 4

type ChipState = Risk | "assessing" | "unassessed"

const CHIP_STYLE: Record<ChipState, { label: string; className: string }> = {
  safe: { label: "Safe", className: "bg-status-ok-bg text-status-ok-label" },
  review: { label: "Review", className: "bg-status-minor-bg text-status-minor-label" },
  risky: { label: "Risky", className: "bg-status-major-bg text-status-major-label" },
  assessing: { label: "Assessing", className: "bg-status-neutral-bg text-status-neutral-label" },
  unassessed: { label: "—", className: "font-mono text-muted-foreground" },
}

const RISK_RANK: Record<Risk, number> = { safe: 0, review: 1, risky: 2 }
const VALUE_RANK = { high: 0, medium: 1, low: 2 } as const
const SECTION_LABEL = "text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"

function resultOf(row: ActionRow, state: AssessState | undefined, unavailable: boolean): AssessResult | null {
  if (state && state.state !== "pending") return state.result
  return unavailable ? deterministicResult(row.facts) : null
}

function chipState(state: AssessState | undefined, unavailable: boolean, result: AssessResult | null): ChipState {
  if (state?.state === "failed" || (unavailable && !state)) return result ? result.risk : "unassessed"
  if (!state || state.state === "pending") return unavailable ? "unassessed" : "assessing"
  return state.result.risk
}

function RiskChip({ state }: { state: ChipState }) {
  const style = CHIP_STYLE[state]
  return (
    <span className={cn("inline-flex h-5 min-w-[52px] items-center justify-center rounded-md px-2 text-[11px] font-semibold", style.className)}>
      {style.label}
    </span>
  )
}

function CommandLine({ command }: { command: HowCommand }) {
  return (
    <div className="flex flex-col gap-1.5">
      {command.value && (
        <div className="flex items-center gap-3 rounded-lg bg-gray-100 px-3 py-2">
          <span className="w-16 shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{command.label}</span>
          <code className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[12.5px] text-foreground">{command.value}</code>
          {command.link && (
            <a href={command.link.url} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              {command.link.label}
              <ExternalLink className="size-3" aria-hidden />
            </a>
          )}
          <CopyButton value={command.value} className="shrink-0" />
        </div>
      )}
      {(command.hint || (!command.value && command.link)) && (
        <p className={cn("flex items-center gap-3 text-muted-foreground", command.value ? "px-1 text-xs" : "text-[13px]")}>
          <span>{command.hint}</span>
          {!command.value && command.link && (
            <a href={command.link.url} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 hover:text-foreground">
              {command.link.label}
              <ExternalLink className="size-3" aria-hidden />
            </a>
          )}
        </p>
      )}
    </div>
  )
}

function ChangeGroup({ label, indices, rest = [], result }: { label: string; indices: number[]; rest?: number[]; result: AssessResult }) {
  const [showAll, setShowAll] = useState(false)
  const all = [...indices, ...rest]
  const visible = showAll ? all : indices.slice(0, VISIBLE_BULLETS)
  const hidden = all.length - visible.length
  const toggle = (hidden > 0 || showAll) && (
    <button type="button" onClick={() => setShowAll(v => !v)} className="text-xs text-muted-foreground hover:text-brand hover:underline">
      {showAll ? "Show less" : `Show ${hidden} more`}
    </button>
  )
  return (
    <div className="grid grid-cols-[92px_1fr] gap-3 border-b border-gray-200 px-4 py-2.5 text-[13px] last:border-b-0">
      <span className={cn("text-xs font-semibold", all.length === 0 ? "text-muted-foreground" : "text-foreground")}>{label}</span>
      {all.length === 0 ? (
        <span className="text-muted-foreground">none</span>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {visible.length === 0 && (
            <li className="flex items-center gap-2 text-muted-foreground">
              nothing notable
              <span>·</span>
              {toggle}
            </li>
          )}
          {visible.map(i => {
            const entry = result.entries[i]
            if (!entry) return null
            return (
              <li key={i} className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-start gap-2 leading-snug">
                <span aria-hidden className="mt-[7px] size-1 rounded-full bg-gray-400" />
                <span className="line-clamp-2">{entry.text}</span>
                {entry.url ? (
                  <a href={entry.url} target="_blank" rel="noreferrer" className="pt-px font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline">{entry.version} ↗</a>
                ) : (
                  <span className="pt-px font-mono text-[11px] text-muted-foreground">{entry.version}</span>
                )}
              </li>
            )
          })}
          {visible.length > 0 && toggle && <li className="pl-4">{toggle}</li>}
        </ul>
      )}
    </div>
  )
}

function ValuesLine({ result }: { result: AssessResult }) {
  const breaks = result.affects.filter(a => a.effect === "breaks")
  const changes = result.affects.filter(a => a.effect === "changes")
  const affected = [...breaks, ...changes].filter((a, i, all) => all.findIndex(b => b.config === a.config) === i)
  const label = result.configKeys.some(k => k.type === "flag") ? "Your flags" : "Your values"
  return (
    <div className="grid grid-cols-[110px_1fr] items-baseline gap-4 border-t border-gray-200 px-4 py-2.5 text-[13px]">
      <span className="text-xs font-semibold">{label}</span>
      {affected.length === 0 ? (
        <span className="text-muted-foreground">
          {result.coverage.configKeysTotal === 0 ? "no manager config to check" : `none of ${result.coverage.configKeysTotal} keys affected`}
        </span>
      ) : (
        <span>
          <span className="font-semibold text-status-minor-label">{affected.length} affected</span>
          <span className="text-muted-foreground"> · </span>
          {affected.map((a, i) => (
            <span key={`${a.entry}-${a.config}`}>
              {i > 0 && <span className="text-muted-foreground">, </span>}
              <code className="rounded bg-gray-100 px-1 font-mono text-xs">{result.configKeys[a.config]?.path}</code>
              {a.effect === "breaks" && <span className="text-muted-foreground"> (must change)</span>}
            </span>
          ))}
        </span>
      )}
    </div>
  )
}

function Detail({ row, result, state }: { row: ActionRow; result: AssessResult; state: ChipState }) {
  const isPin = row.facts.kind === "pin-digest"
  const lead = state === "unassessed" ? "Not assessed." : VERDICT_LEAD[result.risk]
  const commands = commandsFor(row, result)
  const coverageNote = result.coverage.versionsTotal > result.coverage.versionsCovered
    ? `notes classified for ${result.coverage.versionsCovered} of ${result.coverage.versionsTotal} releases`
    : null
  return (
    <div className="flex flex-col gap-3 border-t border-gray-200 px-5 pb-5 pt-4">
      <div className="grid grid-cols-[110px_1fr] items-baseline gap-4 rounded-lg border border-gray-200 px-4 py-3 text-[13.5px]">
        <span className={SECTION_LABEL}>Verdict</span>
        <p><span className="font-semibold">{lead}</span> {result.verdict}</p>
      </div>

      {!isPin && (
        <div className="rounded-lg border border-gray-200">
          <div className="flex items-baseline gap-3 border-b border-gray-200 px-4 py-2.5">
            <span className={SECTION_LABEL}>What changed</span>
            <span className="font-mono text-xs">{row.facts.from} → {row.facts.to}</span>
            {coverageNote && <span className="ml-auto text-xs text-muted-foreground">{coverageNote}</span>}
          </div>
          {result.coverage.changelog === "none" ? (
            <div className="grid grid-cols-[92px_1fr] gap-3 px-4 py-2.5 text-[13px]">
              <span className="text-xs font-semibold text-muted-foreground">Release notes</span>
              <span className="text-muted-foreground">none found for this {row.facts.kind === "upgrade-chart" ? "chart" : "image"}; verdict uses version distance and the scan only.</span>
            </div>
          ) : (
            <>
              <ChangeGroup label="Breaking" indices={result.groups.breaking} result={result} />
              <ChangeGroup label="Security" indices={result.groups.security} result={result} />
              <ChangeGroup label="Other" indices={result.groups.notable} rest={result.groups.other} result={result} />
            </>
          )}
          <ValuesLine result={result} />
          {result.sources.length > 0 && (
            <p className="border-t border-gray-200 px-4 py-2 text-[11.5px] text-muted-foreground">
              Sources ·{" "}
              {result.sources.map((s, i) => (
                <span key={s.url}>
                  {i > 0 && " · "}
                  <a href={s.url} target="_blank" rel="noreferrer" className="hover:text-foreground hover:underline">{s.label}</a>
                </span>
              ))}
            </p>
          )}
        </div>
      )}

      {isPin && row.facts.digest && (
        <div className="rounded-lg border border-gray-200">
          <div className="grid grid-cols-[92px_1fr] gap-3 border-b border-gray-200 px-4 py-2.5 text-[13px]">
            <span className="text-xs font-semibold">Running</span>
            <span>digest <code className="rounded bg-gray-100 px-1 font-mono text-xs">{row.facts.digest.slice(0, 19)}…</code>, published as <code className="rounded bg-gray-100 px-1 font-mono text-xs">{row.facts.to}</code></span>
          </div>
          <div className="grid grid-cols-[92px_1fr] gap-3 px-4 py-2.5 text-[13px]">
            <span className="text-xs font-semibold">Manifest says</span>
            <span><code className="rounded bg-gray-100 px-1 font-mono text-xs">{row.facts.from}</code>, which now points at a different build</span>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-gray-200">
        <div className="border-b border-gray-200 px-4 py-2.5">
          <span className={SECTION_LABEL}>How to fix</span>
        </div>
        <div className="flex flex-col gap-2 px-4 py-3">
          {commands.map(c => <CommandLine key={c.label + (c.value ?? "")} command={c} />)}
        </div>
      </div>
    </div>
  )
}

function Row({ row, state, result, chip, open, onToggle }: {
  row: ActionRow
  state: AssessState | undefined
  result: AssessResult | null
  chip: ChipState
  open: boolean
  onToggle: () => void
}) {
  const value = result?.value
  const reason = reasonLine(row.facts, result)
  return (
    <div className="border-b border-gray-200 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          "grid h-16 w-full grid-cols-[74px_minmax(0,1fr)_190px_16px] items-center gap-4 px-5 text-left transition-colors hover:bg-gray-50",
          open && "bg-gray-50",
        )}
      >
        <RiskChip state={chip} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm">
            <span className="font-semibold">{row.verb}</span>
            <span className="ml-1.5 text-muted-foreground">{row.name}</span>
          </span>
          <span className="truncate text-[12.5px] text-muted-foreground">
            {value && <><span className="font-semibold text-foreground">{VALUE_LEAD[value]}</span> · </>}
            {reason}
          </span>
        </span>
        <span className="text-right font-mono text-[12.5px]">
          {row.facts.from}<span className="px-1 text-muted-foreground">→</span><span className="font-semibold">{row.facts.to}</span>
        </span>
        <ChevronRight className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      {open && result && <Detail row={row} result={result} state={chip} />}
      {open && !result && state?.state === "pending" && (
        <p className="border-t border-gray-200 px-5 py-4 text-sm text-muted-foreground">Assessing this action. The verdict appears here when it is ready.</p>
      )}
    </div>
  )
}

export default function ActionsCard({ rows, results, unavailable }: ActionAssessments) {
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  if (rows.length === 0) return null

  const enriched = rows.map(row => {
    const state = results[row.key]
    const result = resultOf(row, state, unavailable)
    return { row, state, result, chip: chipState(state, unavailable, result) }
  })
  enriched.sort((a, b) => {
    const ra = a.result ? RISK_RANK[a.result.risk] : 1.5
    const rb = b.result ? RISK_RANK[b.result.risk] : 1.5
    if (ra !== rb) return ra - rb
    const va = a.result ? VALUE_RANK[a.result.value] : 1
    const vb = b.result ? VALUE_RANK[b.result.value] : 1
    return va - vb
  })

  const counts = { safe: 0, review: 0, risky: 0 }
  for (const e of enriched) if (e.result) counts[e.result.risk]++
  const visible = showAll ? enriched : enriched.slice(0, VISIBLE_ROWS)
  const hidden = enriched.length - visible.length

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Actions</p>
      <div className="rounded-xl border border-gray-200 bg-white">
        <div className="flex items-center justify-between gap-4 border-b border-gray-200 px-5 py-3">
          <span className="text-sm text-muted-foreground">
            <span className="font-semibold text-foreground tabular-nums">{rows.length}</span> {rows.length === 1 ? "action" : "actions"}
          </span>
          <div className="flex items-center gap-2">
            {(["safe", "review", "risky"] as const).map(risk => counts[risk] > 0 && (
              <span key={risk} className={cn("rounded-md px-2.5 py-1 text-xs font-semibold tabular-nums", CHIP_STYLE[risk].className)}>
                {CHIP_STYLE[risk].label} {counts[risk]}
              </span>
            ))}
          </div>
        </div>

        {visible.map(({ row, state, result, chip }) => (
          <Row
            key={row.key}
            row={row}
            state={state}
            result={result}
            chip={chip}
            open={openKey === row.key}
            onToggle={() => setOpenKey(openKey === row.key ? null : row.key)}
          />
        ))}

        {(hidden > 0 || showAll) && enriched.length > VISIBLE_ROWS && (
          <button
            type="button"
            onClick={() => setShowAll(v => !v)}
            className="w-full border-b border-gray-200 px-5 py-2.5 text-left text-xs font-medium text-brand-label transition-colors last:border-b-0 hover:bg-gray-50 hover:text-brand-text"
          >
            {showAll ? "Show fewer" : `Show ${hidden} more ${hidden === 1 ? "action" : "actions"}`}
          </button>
        )}

        {unavailable && (
          <p className="px-5 py-1.5 text-[11.5px] text-muted-foreground">
            AI verdicts are off: LLM not configured. Deterministic rows still show; risk and changelog are not assessed.
          </p>
        )}
      </div>
    </div>
  )
}
