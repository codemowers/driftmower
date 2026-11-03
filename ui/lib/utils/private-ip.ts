export function isPrivateOrSpecial(ip: string): boolean {
  if (ip.includes(":")) return isPrivateIPv6(ip)
  return isPrivateIPv4(ip)
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number)
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true
  const [a, b] = parts
  if (a === 10) return true
  if (a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 0) return true
  if (a >= 224) return true
  return false
}

function isPrivateIPv6(ip: string): boolean {
  const low = ip.toLowerCase()
  if (low === "::1" || low === "::") return true
  if (low.startsWith("fe80:") || low.startsWith("fe8") || low.startsWith("fe9")) return true
  if (low.startsWith("fec0:")) return true
  if (low.startsWith("fc") || low.startsWith("fd")) return true
  if (low.startsWith("ff")) return true
  return false
}
