import "server-only"

const IPV4_MAPPED = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i

const WILDCARD_IPS = new Set(["0.0.0.0", "::"])

// Kernel and Kube API spell the same IPv6 address differently; every hub map is keyed by address.
export function normalizeIp(value: string | undefined | null): string {
  if (!value) return ""

  let ip = value.trim()
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1)

  const zone = ip.indexOf("%")
  if (zone !== -1) ip = ip.slice(0, zone)
  if (!ip) return ""

  const mapped = IPV4_MAPPED.exec(ip)
  if (mapped) return mapped[1]

  if (!ip.includes(":")) return ip

  try {
    const hostname = new URL(`http://[${ip}]`).hostname
    return hostname.startsWith("[") ? hostname.slice(1, -1) : hostname
  } catch {
    return ip.toLowerCase()
  }
}

export function isWildcardIp(ip: string): boolean {
  return WILDCARD_IPS.has(ip)
}

export function dialHost(ip: string): string {
  return ip.includes(":") ? `[${ip}]` : ip
}
