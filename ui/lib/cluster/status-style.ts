import type { StatusType } from "./reports"

export type StatusStyle = { bg: string; text: string; label: string }

export const SEVERITY_STYLE: Partial<Record<StatusType, StatusStyle>> = {
  major_behind: { bg: "bg-status-major-bg",   text: "text-status-major-label",   label: "Major" },
  minor_behind: { bg: "bg-status-minor-bg",   text: "text-status-minor-label",   label: "Minor" },
  patch_behind: { bg: "bg-status-patch-bg",   text: "text-status-patch-label",   label: "Patch" },
  up_to_date:   { bg: "bg-status-ok-bg",      text: "text-status-ok-label",      label: "OK" },
  ahead:        { bg: "bg-status-ahead-bg",   text: "text-status-ahead-label",   label: "Ahead" },
  behind:       { bg: "bg-gray-100",          text: "text-muted-foreground",     label: "Behind" },
}

export const SEVERITY_ORDER: Record<StatusType, number> = {
  major_behind: 4,
  minor_behind: 3,
  patch_behind: 2,
  up_to_date:   1,
  ahead:        0,
  behind:       0,
  no_data:     -1,
  no_version:  -1,
}

export const DISPLAY_ORDER: Record<StatusType, number> = {
  major_behind: 0,
  minor_behind: 1,
  patch_behind: 2,
  up_to_date:   3,
  ahead:        4,
  behind:       4,
  no_data:      5,
  no_version:   5,
}

export const STALE_STATUSES: StatusType[] = ["patch_behind", "minor_behind", "major_behind"]

export function isNoData(status: StatusType): boolean {
  return status === "no_data" || status === "no_version" || status === "behind"
}

export type SummaryPill = { label: string; count: number; bg: string; text: string }

const DRIFT_PILL_STATUSES: StatusType[] = ["up_to_date", "patch_behind", "minor_behind", "major_behind", "ahead"]

export function driftSummaryPills(
  statusCounts: Partial<Record<StatusType, number>>,
  noDataCount: number,
): SummaryPill[] {
  const pills = DRIFT_PILL_STATUSES.flatMap(status => {
    const style = SEVERITY_STYLE[status]
    return style ? [{ label: style.label, count: statusCounts[status] ?? 0, bg: style.bg, text: style.text }] : []
  })
  if (noDataCount > 0) {
    pills.push({ label: "No data", count: noDataCount, bg: "bg-status-neutral-bg", text: "text-status-neutral-label" })
  }
  return pills
}

export function staleText(staleRepoCount: number, distinctRepoCount: number): string {
  if (staleRepoCount === 0) return "text-foreground"
  if (staleRepoCount === distinctRepoCount) return "text-status-major-label"
  return "text-status-minor-label"
}
