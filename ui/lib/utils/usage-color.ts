export function usageBarColor(pct: number): string {
  if (pct < 0.7) return "bg-usage-low"
  if (pct < 0.85) return "bg-usage-medium"
  return "bg-usage-high"
}
