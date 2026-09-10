import type { FindingSeverity } from "./types"

// Mirrors lib/cluster/styles/status-style.ts: severity maps onto the existing
// status-* token families rather than introducing a parallel palette.
export type FindingStyle = { bg: string; text: string; label: string; icon: "blocker" | "warning" | "note" }

export const FINDING_STYLE: Record<FindingSeverity, FindingStyle> = {
  blocker: {
    bg: "bg-status-major-bg",
    text: "text-status-major-text",
    label: "text-status-major-label",
    icon: "blocker",
  },
  warning: {
    bg: "bg-status-minor-bg",
    text: "text-status-minor-text",
    label: "text-status-minor-label",
    icon: "warning",
  },
  note: {
    bg: "bg-status-neutral-bg",
    text: "text-status-neutral-text",
    label: "text-status-neutral-label",
    icon: "note",
  },
}

export const FINDING_ORDER: Record<FindingSeverity, number> = {
  blocker: 0,
  warning: 1,
  note: 2,
}

export const SEVERITY_NOUN: Record<FindingSeverity, string> = {
  blocker: "Blocker",
  warning: "Watch out",
  note: "Worth knowing",
}
