import type { StatusType } from "@/lib/cluster/reports"

export type StatusStyle = { bg: string; text: string; label: string }

export const SEVERITY_STYLE: Record<StatusType, StatusStyle> = {
  major_behind: { bg: "bg-status-major-bg",   text: "text-status-major-label",   label: "Major" },
  minor_behind: { bg: "bg-status-minor-bg",   text: "text-status-minor-label",   label: "Minor" },
  patch_behind: { bg: "bg-status-patch-bg",   text: "text-status-patch-label",   label: "Patch" },
  behind:       { bg: "bg-status-behind-bg",  text: "text-status-behind-label",  label: "Behind" },
  up_to_date:   { bg: "bg-status-ok-bg",      text: "text-status-ok-label",      label: "OK" },
  ahead:        { bg: "bg-status-ahead-bg",   text: "text-status-ahead-label",   label: "Ahead" },
  no_data:      { bg: "bg-status-neutral-bg", text: "text-status-neutral-label", label: "No data" },
  no_version:   { bg: "bg-status-neutral-bg", text: "text-status-neutral-label", label: "No version" },
}

export const SEVERITY_ORDER: Record<StatusType, number> = {
  major_behind: 5,
  minor_behind: 4,
  patch_behind: 3,
  behind:       2,
  up_to_date:   1,
  ahead:        0,
  no_data:     -1,
  no_version:  -1,
}

// Ranks the absence family, which SEVERITY_ORDER cannot; the two differ on purpose.
export const HISTORY_SEVERITY: Record<StatusType, number> = {
  major_behind: 6,
  minor_behind: 5,
  patch_behind: 4,
  behind:       3,
  up_to_date:   2,
  ahead:        1,
  no_data:      0,
  no_version:   0,
}

export const DISPLAY_ORDER: Record<StatusType, number> = {
  major_behind: 0,
  minor_behind: 1,
  patch_behind: 2,
  behind:       3,
  up_to_date:   4,
  ahead:        5,
  no_data:      6,
  no_version:   6,
}

export const STALE_STATUSES: StatusType[] = ["patch_behind", "minor_behind", "major_behind", "behind"]

export function isNoData(status: StatusType): boolean {
  return status === "no_data" || status === "no_version" || status === "behind"
}

export type SummaryPill = { label: string; count: number; bg: string; text: string }

export const DRIFT_PILL_STATUSES: StatusType[] = ["ahead", "up_to_date", "patch_behind", "minor_behind", "major_behind"]

export function driftSummaryPills(
  statusCounts: Partial<Record<StatusType, number>>,
  noDataCount: number,
): SummaryPill[] {
  const pills = DRIFT_PILL_STATUSES.map(status => {
    const style = SEVERITY_STYLE[status]
    return { label: style.label, count: statusCounts[status] ?? 0, bg: style.bg, text: style.text }
  })
  if (noDataCount > 0) {
    const style = SEVERITY_STYLE.no_data
    pills.push({ label: style.label, count: noDataCount, bg: style.bg, text: style.text })
  }
  return pills
}

export function staleText(staleRepoCount: number, distinctRepoCount: number): string {
  if (staleRepoCount === 0) return "text-foreground"
  if (staleRepoCount === distinctRepoCount) return "text-status-major-label"
  return "text-status-minor-label"
}
