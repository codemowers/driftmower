import type { StatusType } from "./reports"

export type StatusStyle = { bg: string; text: string; label: string }

export const SEVERITY_STYLE: Partial<Record<StatusType, StatusStyle>> = {
  major_behind: { bg: "bg-status-major-bg", text: "text-status-major-label", label: "Major" },
  minor_behind: { bg: "bg-status-minor-bg", text: "text-status-minor-label", label: "Minor" },
  patch_behind: { bg: "bg-status-patch-bg", text: "text-status-patch-label", label: "Patch" },
  up_to_date:   { bg: "bg-status-ok-bg",    text: "text-status-ok-label",    label: "OK" },
}

export function isNoData(status: StatusType): boolean {
  return status === "no_data" || status === "no_version"
}

export function staleText(staleRepoCount: number, distinctRepoCount: number): string {
  if (staleRepoCount === 0) return "text-foreground"
  if (staleRepoCount === distinctRepoCount) return "text-status-major-label"
  return "text-status-minor-label"
}
