export function usageBarColor(pct: number): string {
  if (pct < 0.7) return "bg-status-ok"
  if (pct < 0.85) return "bg-status-minor"
  return "bg-status-major"
}
