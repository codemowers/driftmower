const RTF = new Intl.RelativeTimeFormat("en", { numeric: "auto" })

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year",   365 * 24 * 60 * 60 * 1000],
  ["month",   30 * 24 * 60 * 60 * 1000],
  ["week",     7 * 24 * 60 * 60 * 1000],
  ["day",          24 * 60 * 60 * 1000],
  ["hour",              60 * 60 * 1000],
  ["minute",                 60 * 1000],
]

export function relativeTimeFromNow(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const diffMs = t - Date.now()
  const absMs = Math.abs(diffMs)
  for (const [unit, ms] of UNITS) {
    if (absMs >= ms) {
      return RTF.format(Math.round(diffMs / ms), unit)
    }
  }
  return RTF.format(Math.round(diffMs / 1000), "second")
}

const COMPACT_UNITS: Array<[string, number]> = [
  ["y",  365 * 24 * 60 * 60 * 1000],
  ["mo",  30 * 24 * 60 * 60 * 1000],
  ["w",    7 * 24 * 60 * 60 * 1000],
  ["d",        24 * 60 * 60 * 1000],
  ["h",             60 * 60 * 1000],
  ["m",                  60 * 1000],
]

// Compact variant of relativeTimeFromNow: "6h ago", "3mo ago", "in 5mo".
export function compactRelativeTimeFromNow(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const diffMs = t - Date.now()
  const absMs = Math.abs(diffMs)
  const future = diffMs > 0
  for (const [short, ms] of COMPACT_UNITS) {
    if (absMs >= ms) {
      const n = Math.round(absMs / ms)
      return future ? `in ${n}${short}` : `${n}${short} ago`
    }
  }
  return future ? "soon" : "just now"
}
