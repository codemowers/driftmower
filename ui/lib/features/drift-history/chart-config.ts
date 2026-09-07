import type { ChartConfig } from "@/components/ui/chart"

export const DRIFT_CHART_CONFIG = {
  ahead: { label: "Ahead", color: "var(--color-status-ahead-bg)" },
  up_to_date: { label: "Up to date", color: "var(--color-status-ok-bg)" },
  patch_behind: { label: "Patch behind", color: "var(--color-status-patch-bg)" },
  minor_behind: { label: "Minor behind", color: "var(--color-status-minor-bg)" },
  major_behind: { label: "Major behind", color: "var(--color-status-major-bg)" },
  behind: { label: "Behind", color: "var(--color-status-behind-bg)" },
  no_data: { label: "No data", color: "var(--color-status-neutral-bg)" },
  rottenness: { label: "Rottenness", color: "var(--color-brand)" },
} satisfies ChartConfig



