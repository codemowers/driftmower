"use client"

import { useState } from "react"
import { useSearchParams } from "next/navigation"
import { ChevronRight, ExternalLink } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import CopyButton from "./copy-button"
import { CHIP_STYLE, enrichRow, RISK_RANK, RiskChip, VALUE_RANK, type Assessed, type EnrichedRow } from "./actions-chip"
import { commandsFor } from "@/lib/features/actions/derive"
import { reasonLine, VALUE_LEAD, VERDICT_LEAD } from "@/lib/features/actions/verdict"
import type { ActionRow, AssessResult, AssessState, HowCommand } from "@/lib/features/actions/types"
import type { ActionAssessments } from "@/lib/features/actions/use-action-assessments"
import { livePatchUpgradeEligible } from "@/lib/features/live-patch-upgrade/gate"
import { useLivePatchUpgrade } from "@/lib/features/live-patch-upgrade/use-live-patch-upgrade"
import LivePatchUpgradeBlock from "./live-patch-upgrade-block"
import LivePatchUpgradePill from "./live-patch-upgrade-pill"

const VISIBLE_ROWS = 4
const VISIBLE_BULLETS = 4
const SECTION_LABEL = "text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"

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

function ChangesBody({ row, result }: { row: ActionRow; result: AssessResult }) {
  return (
    <>
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
    </>
  )
}

function ChangesBox({ row, result }: { row: ActionRow; result: AssessResult }) {
  const coverageNote = result.coverage.versionsTotal > result.coverage.versionsCovered
    ? `notes classified for ${result.coverage.versionsCovered} of ${result.coverage.versionsTotal} releases`
    : null
  return (
    <div className="rounded-lg border border-gray-200">
      <div className="flex items-baseline gap-3 border-b border-gray-200 px-4 py-2.5">
        <span className={SECTION_LABEL}>What changed</span>
        <span className="font-mono text-xs">{row.facts.from} → {row.facts.to}</span>
        {coverageNote && <span className="ml-auto text-xs text-muted-foreground">{coverageNote}</span>}
      </div>
      <ChangesBody row={row} result={result} />
    </div>
  )
}

function changesSummary(result: AssessResult | null, state: AssessState | undefined): string {
  if (!result) return state?.state === "pending" || !state ? "Assessing" : "not assessed"
  if (result.coverage.changelog === "none") return "no release notes"
  const other = result.groups.notable.length + result.groups.other.length
  return [
    result.groups.breaking.length > 0 ? `${result.groups.breaking.length} breaking` : null,
    result.groups.security.length > 0 ? `${result.groups.security.length} security` : null,
    other > 0 ? `${other} other` : null,
  ].filter(Boolean).join(" · ") || "nothing notable"
}

function AbsorbedStrip({ item }: { item: Assessed }) {
  const [open, setOpen] = useState(false)
  const { row, result, state } = item
  return (
    <div className="rounded-lg border border-gray-200">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className={cn("flex w-full items-baseline gap-3 px-4 py-2.5 text-left transition-colors hover:bg-gray-50", open && "border-b border-gray-200")}
      >
        <span className={SECTION_LABEL}>Image {row.name}</span>
        <span className="font-mono text-xs">{row.facts.from} → {row.facts.to}</span>
        <span className="ml-auto text-xs text-muted-foreground">{changesSummary(result, state)}</span>
        <ChevronRight className={cn("size-3.5 self-center text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      {open && (result ? (
        <ChangesBody row={row} result={result} />
      ) : (
        <p className="px-4 py-2.5 text-[13px] text-muted-foreground">Assessing the image change. Its notes appear here when ready.</p>
      ))}
    </div>
  )
}

function Detail({ item, result }: { item: EnrichedRow; result: AssessResult }) {
  const { row, chip: state, absorbed } = item
  const livePatchUpgrade = useLivePatchUpgrade(row.facts)
  const isPin = row.facts.kind === "pin-digest"
  const lead = state === "unassessed" ? "Not assessed." : VERDICT_LEAD[result.risk]
  const commands = commandsFor(row, result, row.relation)
  const target = row.target
  const showLivePatchUpgrade = livePatchUpgrade.available && state !== "assessing" && (livePatchUpgrade.active !== null || livePatchUpgradeEligible(item))
  return (
    <div className="flex flex-col gap-3 border-t border-gray-200 px-5 pb-5 pt-4">
      <div className="grid grid-cols-[110px_1fr] items-baseline gap-4 rounded-lg border border-gray-200 px-4 py-3 text-[13.5px]">
        <span className={SECTION_LABEL}>Verdict</span>
        <p><span className="font-semibold">{lead}</span> {result.verdict}</p>
      </div>

      {!isPin && <ChangesBox row={row} result={result} />}

      {absorbed.map(a => <AbsorbedStrip key={a.row.key} item={a} />)}

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
        {showLivePatchUpgrade && target ? (
          <div className="flex flex-col gap-3 px-4 py-3">
            <div className="flex flex-col gap-2">
              <span className={SECTION_LABEL}>Temporary fix</span>
              <LivePatchUpgradeBlock row={row} target={target} state={livePatchUpgrade} />
            </div>
            <div className="flex flex-col gap-2 border-t border-gray-200 pt-3">
              <span className={SECTION_LABEL}>Permanent fix</span>
              {commands.map(c => <CommandLine key={c.label + (c.value ?? "")} command={{ ...c, hint: permanentHint(c.hint) }} />)}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 px-4 py-3">
            {commands.map(c => <CommandLine key={c.label + (c.value ?? "")} command={c} />)}
          </div>
        )}
      </div>
    </div>
  )
}

const PERMANENT_HINT = "Still needed after the temporary fix."

function permanentHint(hint: string | undefined): string {
  return hint ? `${hint} ${PERMANENT_HINT}` : PERMANENT_HINT
}

function Row({ item, open, onToggle }: { item: EnrichedRow; open: boolean; onToggle: () => void }) {
  const { row, state, result, chip, value } = item
  const livePatchUpgrade = useLivePatchUpgrade(row.facts)
  const showPill = livePatchUpgrade.active !== null && chip !== "assessing"
  const reason = reasonLine(row.facts, result, { relation: row.relation, absorbed: row.absorbed, displayFrom: row.displayFrom })
  return (
    <div className="border-b border-gray-200 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          "grid h-16 w-full grid-cols-[74px_minmax(0,1fr)_minmax(190px,auto)_16px] items-center gap-4 px-5 text-left transition-colors hover:bg-gray-50",
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
        <span className="flex items-center justify-end gap-3 font-mono text-[12.5px]">
          {showPill && <LivePatchUpgradePill />}
          <span>{row.displayFrom}<span className="px-1 text-muted-foreground">→</span><span className="font-semibold">{row.facts.to}</span></span>
        </span>
        <ChevronRight className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      {open && result && <Detail item={item} result={result} />}
      {open && !result && state?.state === "pending" && (
        <p className="border-t border-gray-200 px-5 py-4 text-sm text-muted-foreground">Assessing this action. The verdict appears here when it is ready.</p>
      )}
    </div>
  )
}

export default function ActionsCard({ displayRows, results, unavailable }: ActionAssessments) {
  const deepLink = useSearchParams().get("action")
  const [openKey, setOpenKey] = useState<string | null>(deepLink)
  const [showAll, setShowAll] = useState(false)

  if (displayRows.length === 0) return null

  const enriched = displayRows.map(row => enrichRow(row, results, unavailable !== null))
  enriched.sort((a, b) => {
    const ra = a.risk ? RISK_RANK[a.risk] : 1.5
    const rb = b.risk ? RISK_RANK[b.risk] : 1.5
    if (ra !== rb) return ra - rb
    const va = a.value ? VALUE_RANK[a.value] : 1
    const vb = b.value ? VALUE_RANK[b.value] : 1
    if (va !== vb) return va - vb
    return Number(b.row.facts.kind === "upgrade-chart") - Number(a.row.facts.kind === "upgrade-chart")
  })

  const counts = { safe: 0, review: 0, risky: 0 }
  for (const e of enriched) if (e.risk && e.chip !== "assessing") counts[e.risk]++
  const openIndex = openKey ? enriched.findIndex(e => e.row.key === openKey) : -1
  const expanded = showAll || openIndex >= VISIBLE_ROWS
  const visible = expanded ? enriched : enriched.slice(0, VISIBLE_ROWS)
  const hidden = enriched.length - visible.length

  function toggleAll() {
    if (expanded && openIndex >= VISIBLE_ROWS) setOpenKey(null)
    setShowAll(!expanded)
  }

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Actions</p>
      <div className="rounded-xl border border-gray-200 bg-white">
        <div className="flex items-center justify-between gap-4 border-b border-gray-200 px-5 py-3">
          <span className="text-sm text-muted-foreground">
            <span className="font-semibold text-foreground tabular-nums">{displayRows.length}</span> {displayRows.length === 1 ? "action" : "actions"}
          </span>
          <div className="flex items-center gap-2">
            {(["safe", "review", "risky"] as const).map(risk => counts[risk] > 0 && (
              <span key={risk} className={cn("rounded-md px-2.5 py-1 text-xs font-semibold tabular-nums", CHIP_STYLE[risk].className)}>
                {CHIP_STYLE[risk].label} {counts[risk]}
              </span>
            ))}
          </div>
        </div>

        {visible.map(item => (
          <Row
            key={item.row.key}
            item={item}
            open={openKey === item.row.key}
            onToggle={() => setOpenKey(openKey === item.row.key ? null : item.row.key)}
          />
        ))}

        {enriched.length > VISIBLE_ROWS && (
          <button
            type="button"
            onClick={toggleAll}
            className="w-fit px-5 py-2.5 text-left text-xs text-muted-foreground hover:text-brand hover:underline"
          >
            {expanded ? "Show fewer" : `Show ${hidden} more ${hidden === 1 ? "action" : "actions"}`}
          </button>
        )}

        {unavailable && (
          <p className="px-5 py-1.5 text-[11.5px] text-muted-foreground">
            AI verdicts are off ({unavailable}). Deterministic rows still show; risk and changelog are not assessed.
          </p>
        )}
      </div>
    </div>
  )
}
