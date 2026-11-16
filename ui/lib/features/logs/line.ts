

export function compareNs(a: string, b: string): number {
  const x = BigInt(a)
  const y = BigInt(b)
  return x < y ? -1 : x > y ? 1 : 0
}

export function formatLogTime(tsMs: number): string {
  const d = new Date(tsMs)
  const pad = (n: number) => String(n).padStart(2, "0")
  const date = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${pad(d.getFullYear() % 100)}`
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// RFC 3339 with nanoseconds, for a timestamp in nanoseconds since the epoch.
export function nsToRFC3339(ns: string): string {
  const value = BigInt(ns)
  const billion = BigInt(1_000_000_000)
  const seconds = value / billion
  const fraction = (value % billion).toString().padStart(9, "0")
  return new Date(Number(seconds) * 1000).toISOString().replace(/\.\d{3}Z$/, `.${fraction}Z`)
}
