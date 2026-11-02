function round1(n: number): number {
  return Math.round(n * 10) / 10
}

export function formatBytes(bytes: number): string {
  const tb = bytes / 1e12
  if (tb >= 1) return `${tb.toFixed(1)} TB`
  const gb = bytes / 1e9
  if (gb >= 1) return `${gb >= 10 ? Math.round(gb) : round1(gb)} GB`
  const mb = bytes / 1e6
  if (mb >= 1) return `${mb >= 10 ? Math.round(mb) : round1(mb)} MB`
  const kb = bytes / 1e3
  if (kb >= 1) return `${Math.round(kb)} KB`
  return `${Math.round(bytes)} B`
}

export function formatCores(cores: number): string {
  if (cores < 1) return `${Math.round(cores * 1000)}m`
  const n = cores >= 10 ? Math.round(cores) : Math.round(cores * 10) / 10
  return `${n} ${n === 1 ? "core" : "cores"}`
}
