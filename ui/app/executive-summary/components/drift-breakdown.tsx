import Card from "@/app/components/layout/card"
import { cn } from "@/lib/utils/cn"
import type { ReportReadiness } from "@/lib/cluster/report-readiness"
import { type StatAccent } from "./stat-card"

type Props = {
  readiness: ReportReadiness
  total: number
  behind: number
  ok: number
  patch: number
  minor: number
  major: number
}

type Segment = {
  key: string
  count: number
  label: string
  hint: string
  accent: StatAccent
  barBg: string
  barText: string
}

const SEGMENTS = (behind: number, ok: number, patch: number, minor: number, major: number): Segment[] => [
  { key: "ok",    count: ok,    label: "OK",    hint: "up to date",    accent: "ok",    barBg: "bg-status-ok-bg",    barText: "text-status-ok-label" },
  { key: "patch", count: patch, label: "Patch", hint: "patch behind",  accent: "patch", barBg: "bg-status-patch-bg", barText: "text-status-patch-label" },
  { key: "minor", count: minor, label: "Minor", hint: "minor behind",  accent: "minor", barBg: "bg-status-minor-bg", barText: "text-status-minor-label" },
  { key: "major", count: major, label: "Major", hint: "major behind",  accent: "major", barBg: "bg-status-major-bg", barText: "text-status-major-label" },
  { key: "behind", count: behind, label: "Behind", hint: "release not comparable", accent: "ahead", barBg: "bg-status-ahead-bg", barText: "text-status-ahead-label" },
]

const MIN_PERCENTAGE_FOR_LABEL = 5

const UNMEASURED: Partial<Record<ReportReadiness, string>> = {
  "no-reports": "Drift appears after the first analysis.",
  unresolved: "No running version could be compared with a release yet.",
}

export default function DriftBreakdown({ readiness, total, behind, ok, patch, minor, major }: Props) {
  const segments = SEGMENTS(behind, ok, patch, minor, major)
  const known = behind + ok + patch + minor + major
  const ready = readiness === "ready" || readiness === "unresolved"
  const unmeasured = UNMEASURED[readiness]

  return (
    <Card title="Container drift" meta={ready ? `${known} of ${total} containers with known versions` : undefined}>

      {/* Zeros in traffic-light colours read as measured values, so the cells are replaced. */}
      {unmeasured ? (
        <div className="flex flex-1 items-center justify-center py-4 text-center text-sm text-muted-foreground">
          {unmeasured}
        </div>
      ) : (
        <div className="grid flex-1 auto-cols-fr grid-flow-col gap-4">
          {segments
            .filter(s => s.key !== "behind" || !ready || s.count > 0)
            .map(s => (
              <div key={s.key} className="min-w-0 py-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{s.label}</p>
                <p className={cn("text-3xl font-semibold tabular-nums", s.barText)}>{ready ? s.count : "—"}</p>
                <p className="text-xs text-muted-foreground">{s.hint}</p>
              </div>
            ))}
        </div>
      )}

      {ready && known > 0 && (
        <div className="flex h-9 flex-row gap-1.5">
          {segments
            .filter(s => s.count > 0)
            .map(s => {
              const percentage = (s.count / known) * 100
              return (
                <div
                  key={s.key}
                  title={`${s.label} · ${s.count} containers · ${percentage.toFixed(0)}%`}
                  className={cn("flex min-w-2 items-center justify-center overflow-hidden rounded-lg", s.barBg)}
                  style={{ width: `${percentage}%` }}
                >
                  {percentage >= MIN_PERCENTAGE_FOR_LABEL && (
                    <span className={cn("truncate px-2 text-xs font-semibold tabular-nums", s.barText)}>
                      {percentage.toFixed(0)}%
                    </span>
                  )}
                </div>
              )
            })}
        </div>
      )}
    </Card>
  )
}
