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
