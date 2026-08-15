import { cn } from "@/lib/utils/cn"
import StatCard, { type StatAccent } from "./stat-card"

type Props = {
  ready?: boolean
  total: number
  ahead: number
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

const SEGMENTS = (ahead: number, ok: number, patch: number, minor: number, major: number): Segment[] => [
  { key: "ahead", count: ahead, label: "Ahead", hint: "beyond latest", accent: "ahead", barBg: "bg-status-ahead-bg", barText: "text-status-ahead-label" },
  { key: "ok",    count: ok,    label: "OK",    hint: "up to date",    accent: "ok",    barBg: "bg-status-ok-bg",    barText: "text-status-ok-label" },
  { key: "patch", count: patch, label: "Patch", hint: "patch behind",  accent: "patch", barBg: "bg-status-patch-bg", barText: "text-status-patch-label" },
  { key: "minor", count: minor, label: "Minor", hint: "minor behind",  accent: "minor", barBg: "bg-status-minor-bg", barText: "text-status-minor-label" },
  { key: "major", count: major, label: "Major", hint: "major behind",  accent: "major", barBg: "bg-status-major-bg", barText: "text-status-major-label" },
]

const MIN_PERCENTAGE_FOR_LABEL = 5

export default function DriftBreakdown({ ready = true, total, ahead, ok, patch, minor, major }: Props) {
  const segments = SEGMENTS(ahead, ok, patch, minor, major)
  const known = ahead + ok + patch + minor + major

  return (
    <div className="flex flex-col gap-3 pt-1.5">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Container drift
        </p>
        {ready && (
          <p className="text-xs text-muted-foreground">
            <span className="tabular-nums">{known}</span> of <span className="tabular-nums">{total}</span> containers with known versions
          </p>
        )}
      </div>

      <div className="grid flex-1 auto-cols-fr grid-flow-col gap-4">
        {segments
          .filter(s => s.key !== "ahead" || !ready || s.count > 0)
          .map(s => (
            <StatCard
              key={s.key}
              value={ready ? s.count : <span className="text-2xl font-normal">–</span>}
              accent={s.accent}
              valueTone={s.accent}
              label={s.label}
              hint={s.hint}
            />
          ))}
      </div>

      {ready && known > 0 && (
        <div className="mt-3 flex h-9 flex-row gap-1.5">
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
    </div>
  )
}
