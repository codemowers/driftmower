import type { BandStatus } from "./types"

export type BandStyle = {
  bg: string
  fill: string
  baseline: string
  label: string
}

export const BAND_STYLE: Record<BandStatus, BandStyle> = {
  up_to_date: {
    bg: "bg-status-ok-bg",
    fill: "var(--color-status-ok-bg)",
    baseline: "var(--color-status-ok)",
    label: "Up to date",
  },
  ahead: {
    bg: "bg-status-ahead-bg",
    fill: "var(--color-status-ahead-bg)",
    baseline: "var(--color-status-ahead)",
    label: "Ahead",
  },
  patch_behind: {
    bg: "bg-status-patch-bg",
    fill: "var(--color-status-patch-bg)",
    baseline: "var(--color-status-patch)",
    label: "Patch behind",
  },
  minor_behind: {
    bg: "bg-status-minor-bg",
    fill: "var(--color-status-minor-bg)",
    baseline: "var(--color-status-minor)",
    label: "Minor behind",
  },
  major_behind: {
    bg: "bg-status-major-bg",
    fill: "var(--color-status-major-bg)",
    baseline: "var(--color-status-major)",
    label: "Major behind",
  },
  behind: {
    bg: "bg-status-behind-bg",
    fill: "var(--color-status-behind-bg)",
    baseline: "var(--color-status-behind)",
    label: "Behind",
  },
  no_data: {
    bg: "bg-status-neutral-bg",
    fill: "var(--color-status-neutral-bg)",
    baseline: "var(--color-status-neutral)",
    label: "No data",
  },
  no_version: {
    bg: "bg-status-neutral-bg",
    fill: "var(--color-status-neutral-bg)",
    baseline: "var(--color-status-neutral)",
    label: "No data",
  },
  void: {
    bg: "bg-transparent",
    fill: "transparent",
    baseline: "transparent",
    label: "Not deployed",
  },
}

export const LEGEND_ORDER: BandStatus[] = [
  "ahead",
  "up_to_date",
  "patch_behind",
  "minor_behind",
  "major_behind",
  "behind",
  "no_data",
]
