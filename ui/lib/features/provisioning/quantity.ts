// PURE. Kubernetes quantity strings, parsed the way the apiserver means them.
// Needed because quota headroom is arithmetic on `.status.hard` minus
// `.status.used`, and both are strings like "2Gi", "100m" or "1".

// Binary suffixes (1Ki = 1024) and decimal ones (1k = 1000) are different, and
// mixing them up understates a quota by 7% at Gi scale — enough to promise a
// beginner room they do not have.
const BINARY: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
}

const DECIMAL: Record<string, number> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  "": 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
}

// Binary suffixes take an uppercase letter plus "i" (Ki, Mi, Gi, Ti, Pi, Ei);
// decimal ones are a single letter and use lowercase "k" for kilo. So "Ki" is
// valid and "ki" is not, and "k" is valid while "K" is not.
const QUANTITY = /^(-?(?:\d+\.?\d*|\.\d+))((?:[KMGTPE]i)|(?:[numkMGTPE])|)$/

// Returns null rather than 0 for anything unparseable: an unreadable number
// must not silently become "no usage".
export function parseQuantity(value: string | undefined | null): number | null {
  if (value === undefined || value === null) return null
  const text = value.trim()
  if (text === "") return null

  const match = QUANTITY.exec(text)
  if (!match) return null

  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return null

  const suffix = match[2]
  if (suffix in BINARY) return amount * BINARY[suffix]
  if (suffix in DECIMAL) return amount * DECIMAL[suffix]
  return null
}

// CPU is quoted in millicores everywhere in the Kubernetes API, so keep it in
// integers and avoid float drift when summing requests.
export function parseCpuMillis(value: string | undefined | null): number | null {
  const parsed = parseQuantity(value)
  return parsed === null ? null : Math.round(parsed * 1000)
}

export function parseCount(value: string | undefined | null): number | null {
  const parsed = parseQuantity(value)
  return parsed === null ? null : Math.round(parsed)
}

const GI = 1024 ** 3

export function gibibytes(bytes: number): number {
  return bytes / GI
}

export function fromGibibytes(gi: number): number {
  return gi * GI
}

// Formats for the copy rule "numbers carry unit and ceiling". Whole numbers
// stay whole so "10Gi" never renders as "10.0Gi".
export function formatGi(bytes: number): string {
  const gi = gibibytes(bytes)
  const rounded = Math.round(gi * 10) / 10
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}Gi`
}

export function formatCpu(millis: number): string {
  return millis % 1000 === 0 ? `${millis / 1000}` : `${millis}m`
}
