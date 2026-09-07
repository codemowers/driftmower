import { create } from "zustand"

const RDNS_URL = "/api/rdns"

export type RdnsEntry =
  | { status: "loading" }
  | { status: "private" }
  | { status: "resolved"; hostname: string | null }

type RdnsState = {
  cache: Map<string, RdnsEntry>
  revision: number
}

export const useRdns = create<RdnsState>(() => ({
  cache: new Map(),
  revision: 0,
}))

const inflight = new Set<string>()

export function lookupRdns(ip: string): void {
  if (!ip) return
  const existing = useRdns.getState().cache.get(ip)
  if (existing) return
  if (inflight.has(ip)) return

  if (isPrivateOrSpecial(ip)) {
    setEntry(ip, { status: "private" })
    return
  }

  inflight.add(ip)
  setEntry(ip, { status: "loading" })

  fetch(`${RDNS_URL}?ip=${encodeURIComponent(ip)}`, { cache: "no-store" })
    .then(r => (r.ok ? r.json() : { hostname: null }))
    .then((j: { hostname: string | null }) => {
      setEntry(ip, { status: "resolved", hostname: j.hostname })
    })
    .catch(() => {
      setEntry(ip, { status: "resolved", hostname: null })
    })
    .finally(() => {
      inflight.delete(ip)
    })
}

function setEntry(ip: string, entry: RdnsEntry): void {
  useRdns.setState(prev => {
    const cache = new Map(prev.cache)
    cache.set(ip, entry)
    return { cache, revision: prev.revision + 1 }
  })
}

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
