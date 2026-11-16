// Kubernetes resource quantities for storage: parsing to bytes and computing
// the absolute size an expansion submits.

const SUFFIX: Record<string, number> = {
  "": 1,
  k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
  Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60,
}

export function parseQuantity(q: string | null | undefined): number | null {
  if (!q) return null
  const m = /^([0-9]+(?:\.[0-9]+)?)(?:([eE][0-9]+)|([kKMGTPE]i?)?)$/.exec(q.trim())
  if (!m) return null
  const n = Number(m[1])
  if (m[2]) return n * 10 ** Number(m[2].slice(1))
  const mult = SUFFIX[m[3] ?? ""]
  return mult === undefined ? null : n * mult
}

const MIB = 2 ** 20

// The storage request after growing `requested` by `percent`, rounded up to a
// whole MiB and written in the largest binary unit that divides it exactly.
// Commands use this absolute size, so repeating one does not compound growth.
export function expandedStorage(requested: string, percent: number): string | null {
  const bytes = parseQuantity(requested)
  if (bytes === null || bytes <= 0) return null
  const mib = Math.ceil((bytes * (1 + percent / 100)) / MIB)
  for (const [unit, size] of [["Pi", 2 ** 30], ["Ti", 2 ** 20], ["Gi", 2 ** 10]] as const) {
    if (mib % size === 0) return `${mib / size}${unit}`
  }
  return `${mib}Mi`
}
