import { create } from "zustand"
import { isPrivateOrSpecial } from "@/lib/utils/private-ip"

export { isPrivateOrSpecial }

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
