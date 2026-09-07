"use client"

import { useState } from "react"
import Link from "next/link"
import { cn } from "@/lib/utils/cn"
import { useActionAssessments } from "@/lib/features/actions/use-action-assessments"
import { reasonLine, VALUE_LEAD } from "@/lib/features/actions/verdict"
import type { ClusterActionRow, Risk } from "@/lib/features/actions/types"
import { CHIP_STYLE, enrichRow, RiskChip, type EnrichedRow } from "@/app/components/actions-chip"

const INITIAL_COUNT = 5

type Props = { rows: ClusterActionRow[]; currentCharts: ReadonlySet<string>; reportId: string | null }

function isQuickWin(item: EnrichedRow<ClusterActionRow>): boolean {
  return item.risk === "safe" && item.value === "high"
}

function rank(item: EnrichedRow<ClusterActionRow>): number {
  if (item.chip === "assessing") return 2
  return isQuickWin(item) ? 0 : 1
}

function rowHref(row: ClusterActionRow, reportId: string | null): string {
  const params = new URLSearchParams()
  if (reportId) params.set("report", reportId)
  params.set("action", row.key)
  const path = row.facts.kind === "upgrade-chart" && row.releaseUid
    ? `/helm-releases/${row.releaseUid}`
    : `/topmost-owners/${row.owner.uid}`
  return `${path}?${params.toString()}`
}

export default function TopActions({ rows, currentCharts, reportId }: Props) {
  const [expanded, setExpanded] = useState(false)
  const { displayRows, results, unavailable } = useActionAssessments(rows, currentCharts, { focus: false })

  if (displayRows.length === 0) return null

  const enriched = displayRows.map(row => enrichRow(row, results, unavailable))
  enriched.sort((a, b) => rank(a) - rank(b))

  const counts: Record<Risk, number> = { safe: 0, review: 0, risky: 0 }
  for (const item of enriched) if (item.risk && item.chip !== "assessing") counts[item.risk]++
  const shown = expanded ? enriched : enriched.slice(0, INITIAL_COUNT)
  const overflow = enriched.length - INITIAL_COUNT

  return (
    <div className="flex flex-col rounded-xl border border-gray-200 bg-white py-5">
      <div className="mb-4 flex items-center justify-between gap-4 px-6">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Top actions</p>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            <span className="font-semibold text-foreground tabular-nums">{enriched.length}</span> {enriched.length === 1 ? "action" : "actions"}
          </span>
          {(["safe", "review", "risky"] as const).map(risk => counts[risk] > 0 && (
            <span key={risk} className={cn("rounded-md px-2 py-0.5 text-[11px] font-semibold tabular-nums", CHIP_STYLE[risk].className)}>
              {CHIP_STYLE[risk].label} {counts[risk]}
            </span>
          ))}
        </div>
      </div>

      <div className={cn("flex flex-col divide-y divide-gray-100", expanded && "max-h-160 overflow-y-auto")}>
        {shown.map(({ row, result, chip, value }) => (
          <Link
            key={row.key}
            href={rowHref(row, reportId)}
            className="flex cursor-pointer items-center gap-4 px-6 py-2.5 transition-colors hover:bg-brand-bg"
          >
            <span className="w-[84px] shrink-0">
              <RiskChip state={chip} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">
                <span className="font-semibold">{row.verb}</span>
                <span className="ml-1.5 text-muted-foreground">{row.name}</span>
                <span className="ml-1.5 font-mono text-xs text-muted-foreground">{row.owner.namespace}/{row.owner.name}</span>
              </p>
              <p className="truncate text-[12.5px] text-muted-foreground">
                {value && <><span className="font-semibold text-foreground">{VALUE_LEAD[value]}</span> · </>}
                {reasonLine(row.facts, result, { relation: row.relation, absorbed: row.absorbed, displayFrom: row.displayFrom })}
              </p>
            </div>
            <span className="shrink-0 font-mono text-[12.5px]">
              {row.displayFrom}<span className="px-1 text-muted-foreground">→</span><span className="font-semibold">{row.facts.to}</span>
            </span>
          </Link>
        ))}
      </div>

      {overflow > 0 && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="mt-3 w-fit px-6 text-xs text-muted-foreground hover:text-brand hover:underline"
        >
          +{overflow} more
        </button>
      )}
      {expanded && (
        <button
          onClick={() => setExpanded(false)}
          className="mt-3 w-fit px-6 text-xs text-muted-foreground hover:text-brand hover:underline"
        >
          show less
        </button>
      )}

      {unavailable && (
        <p className="mt-3 px-6 text-[11.5px] text-muted-foreground">
          AI verdicts are off: LLM not configured. Deterministic rows still show; risk and changelog are not assessed.
        </p>
      )}
    </div>
  )
}
