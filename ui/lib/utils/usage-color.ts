// Threshold-based fill color for a 0..1 usage fraction:
// green below 70%, amber below 85%, red at or above.
export function usageBarColor(pct: number): string {
  if (pct < 0.7) return "bg-status-ok"
  if (pct < 0.85) return "bg-status-minor"
  return "bg-status-major"
}
