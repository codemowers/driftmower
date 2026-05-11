import { promises as dns } from "node:dns"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

type Entry = { hostname: string | null; expiresAt: number }

const cache = new Map<string, Entry>()
const POSITIVE_TTL_MS = 10 * 60 * 1000
const NEGATIVE_TTL_MS = 60 * 1000

export async function GET(req: Request) {
  const url = new URL(req.url)
  const ip = url.searchParams.get("ip")
  if (!ip) return Response.json({ hostname: null }, { status: 400 })

  const now = Date.now()
  const cached = cache.get(ip)
  if (cached && cached.expiresAt > now) {
    return Response.json({ hostname: cached.hostname }, { headers: { "Cache-Control": "no-store" } })
  }

  let hostname: string | null = null
  try {
    const names = await dns.reverse(ip)
    hostname = names[0]?.replace(/\.$/, "") ?? null
  } catch {
    hostname = null
  }

  cache.set(ip, {
    hostname,
    expiresAt: now + (hostname ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
  })

  return Response.json({ hostname }, { headers: { "Cache-Control": "no-store" } })
}
