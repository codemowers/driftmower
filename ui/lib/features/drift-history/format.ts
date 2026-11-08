import type { TooltipContentProps } from "recharts"

export function dayLabel(t: number): string {
  return new Date(t).toISOString().slice(0, 10)
}

export function axisDate(t: number): string {
  return new Date(t).toISOString().slice(5, 10)
}

export function percentLabel(ratio: number | null): string {
  return ratio === null ? "—" : `${Math.round(ratio * 100)}%`
}

export function dayCount(days: number | null): string {
  if (days === null) return "—"
  if (days >= 1) return `${Math.round(days)}d`
  const hours = Math.round(days * 24)
  return hours >= 1 ? `${hours}h` : "<1h"
}

type Payload = TooltipContentProps<number, string>["payload"]

export function tooltipDate(_value: unknown, payload: Payload): string {
  const t = payload?.[0]?.payload?.t
  return typeof t === "number" ? dayLabel(t) : ""
}

const DAY_MS = 86_400_000

export function windowSummary(window: {
  windowStart: number
  windowEnd: number
  reportCount: number
}): string {
  const days = Math.round((window.windowEnd - window.windowStart) / DAY_MS)
  return `${window.reportCount} samples · ${days} days of data`
}
