import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"
import { AlertTriangle } from "lucide-react"
import RefreshButton from "@/app/components/core/refresh-button"
import CopyButton from "@/app/components/copy-button"
import Breadcrumbs, { type BreadcrumbItem } from "@/app/components/breadcrumbs"
import { cn } from "@/lib/utils/cn"
import type { StatusType } from "@/lib/cluster/reports"
import { SEVERITY_STYLE } from "@/lib/cluster/status-style"

type Chip = { label: string; tone?: "brand" | "muted"; className?: string }

type Props = {
  icon: LucideIcon
  iconAriaLabel: string
  title: string
  copyValue?: string
  breadcrumbs: BreadcrumbItem[]
  chips?: Chip[]
  scoreChip?: { status: StatusType; score: number; label?: string } | null
  issueCount?: number
  subtitle: ReactNode
}

const CHIP_TONE: Record<NonNullable<Chip["tone"]>, string> = {
  brand: "bg-brand-bg text-brand-label",
  muted: "bg-gray-100 text-muted-foreground",
}

export default function ResourceHeader({
  icon: Icon,
  iconAriaLabel,
  title,
  copyValue,
  breadcrumbs,
  chips,
  scoreChip,
  issueCount,
  subtitle,
}: Props) {
  const scoreStyle = scoreChip ? SEVERITY_STYLE[scoreChip.status] : undefined
  const scoreLabel = scoreChip
    ? scoreChip.label ?? (scoreChip.status === "no_data" || scoreChip.status === "no_version"
        ? "—"
        : scoreChip.score.toFixed(2))
    : ""

  return (
    <header className="flex items-start justify-between gap-8">
      <div className="flex min-w-0 flex-col gap-3">
        <Breadcrumbs items={breadcrumbs} />

        <div className="flex items-center gap-3">
          <div
            className="flex size-12 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-brand-icon"
            aria-label={iconAriaLabel}
          >
            <Icon className="size-6" />
          </div>

          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2.5">
              <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground">
                {title}
              </h1>
              {copyValue && <CopyButton value={copyValue} />}
              {chips?.map((chip, i) => (
                <span
                  key={i}
                  className={cn(
                    "rounded-md px-2 py-0.5 text-xs font-semibold",
                    chip.className ?? CHIP_TONE[chip.tone ?? "brand"],
                  )}
                >
                  {chip.label}
                </span>
              ))}
              {scoreChip && (
                <span
                  className={cn(
                    "rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums",
                    scoreStyle ? [scoreStyle.bg, scoreStyle.text] : "bg-gray-100 text-muted-foreground",
                  )}
                >
                  {scoreLabel}
                </span>
              )}
              {issueCount !== undefined && issueCount > 0 && (
                <span className="flex items-center gap-1 rounded-md bg-status-minor-bg px-1.5 py-0.5 text-status-minor-label">
                  <AlertTriangle className="size-3" />
                  <span className="text-xs font-medium tabular-nums">{issueCount}</span>
                </span>
              )}
            </div>

            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
        </div>
      </div>

      <div className="shrink-0 p-1">
        <RefreshButton />
      </div>
    </header>
  )
}
