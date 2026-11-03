const NS_PER_MS = BigInt(1000000)
const NS_PER_SEC = BigInt(1000000000)

export function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

export function makeKey(tsNs: string, container: string, message: string): string {
  return `${tsNs}:${container}:${fnv1a(message)}`
}

export function compareNs(a: string, b: string): number {
  const x = BigInt(a)
  const y = BigInt(b)
  return x < y ? -1 : x > y ? 1 : 0
}

export function nsToMs(tsNs: string): number {
  return Number(BigInt(tsNs) / NS_PER_MS)
}

export function nowNs(): bigint {
  return BigInt(Date.now()) * NS_PER_MS
}

export function rfc3339ToNs(ts: string): string {
  const ms = Date.parse(ts)
  if (Number.isNaN(ms)) return "0"
  const frac = ts.match(/\.(\d+)/)?.[1] ?? ""
  const fracNs = (frac + "000000000").slice(0, 9)
  const secNs = BigInt(Math.floor(ms / 1000)) * NS_PER_SEC
  return (secNs + BigInt(fracNs)).toString()
}

export function nsToRfc3339(tsNs: string): string {
  const ms = Number(BigInt(tsNs) / NS_PER_MS)
  return new Date(ms).toISOString()
}

export function formatLogTime(tsMs: number): string {
  const d = new Date(tsMs)
  const pad = (n: number) => String(n).padStart(2, "0")
  const date = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${pad(d.getFullYear() % 100)}`
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
