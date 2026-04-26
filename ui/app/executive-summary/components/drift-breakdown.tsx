import { cn } from "@/lib/utils"

type Props = { ok: number; patch: number; minor: number; major: number }

type Segment = {
  key: string
  count: number
  barBg: string
  barText: string
  pillBg: string
  pillText: string
  dotBg: string
  label: string
}

const SEGMENTS = (ok: number, patch: number, minor: number, major: number): Segment[] => [
  { key: "ok",    count: ok,    barBg: "bg-status-ok-bg",    barText: "text-status-ok-label",    pillBg: "bg-status-ok-bg",    pillText: "text-status-ok-label",    dotBg: "bg-status-ok",    label: "OK" },
  { key: "patch", count: patch, barBg: "bg-status-patch-bg",  barText: "text-status-patch-label",  pillBg: "bg-status-patch-bg",  pillText: "text-status-patch-label",  dotBg: "bg-status-patch", label: "Patch" },
  { key: "minor", count: minor, barBg: "bg-status-minor-bg",  barText: "text-status-minor-label",  pillBg: "bg-status-minor-bg",  pillText: "text-status-minor-label",  dotBg: "bg-status-minor", label: "Minor" },
  { key: "major", count: major, barBg: "bg-status-major-bg",  barText: "text-status-major-label",  pillBg: "bg-status-major-bg",  pillText: "text-status-major-label",  dotBg: "bg-status-major", label: "Major" },
]

const MIN_PERCENTAGE_FOR_LABEL = 6

export default function DriftBreakdown({ ok, patch, minor, major }: Props) {
  const total = ok + patch + minor + major
  if (total === 0) return null

  const segments = SEGMENTS(ok, patch, minor, major)

  return (
    <div className="rounded-xl border border-gray-200 bg-white px-6 py-5">
      <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Drift Breakdown
      </p>
      <div className="flex items-center gap-7">

        {/* Bar */}
        <div className="flex h-9 min-w-0 flex-1 flex-row gap-1.5">
          {segments
            .filter(s => s.count > 0)
            .map(s => {
              const percentage = (s.count / total) * 100
              return (
                <div
                  key={s.key}
                  className={cn("flex items-center justify-center overflow-hidden rounded-lg", s.barBg)}
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

        {/* Pills */}
        <div className="flex shrink-0 flex-col gap-1.5">
          {segments.map(s => (
            <div key={s.key} className={cn("flex items-center gap-1.5 rounded-full pl-2.5 pr-4 py-1", s.pillBg)}>
              <span className={cn("h-2 w-2 shrink-0 rounded-full", s.dotBg)} />
              <span className={cn("text-xs font-semibold uppercase tracking-wide", s.pillText)}>
                {s.label}
              </span>
            </div>
          ))}
        </div>

      </div>
    </div>
  )
}
