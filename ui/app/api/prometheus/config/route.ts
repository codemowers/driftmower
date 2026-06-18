import { isInCluster, kubeApiGet } from "@/lib/api/k8s"

export const dynamic = "force-dynamic"

type Ingress = {
  spec?: {
    tls?: { hosts?: string[] }[]
    rules?: { host?: string }[]
  }
}

const CACHE_TTL_MS = 30_000
let cached: { url: string; expiresAt: number } | null = null

function pickHost(ingress: Ingress): string {
  const tlsHost = ingress.spec?.tls?.flatMap(t => t.hosts ?? [])[0]
  if (tlsHost) return `https://${tlsHost}`
  const ruleHost = ingress.spec?.rules?.[0]?.host
  if (ruleHost) return `http://${ruleHost}`
  return ""
}

async function discover(): Promise<string> {
  const override = process.env.PROMETHEUS_URL
  if (override) return override

  if (!isInCluster()) return ""

  const ingress = await kubeApiGet<Ingress>(
    "/apis/networking.k8s.io/v1/namespaces/monitoring/ingresses/prometheus",
  )
  return pickHost(ingress)
}

export async function GET() {
  const now = Date.now()
  if (cached && cached.expiresAt > now) {
    return Response.json({ url: cached.url }, { headers: { "Cache-Control": "no-store" } })
  }
  try {
    const url = await discover()
    cached = { url, expiresAt: now + CACHE_TTL_MS }
    return Response.json({ url }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return Response.json(
      { url: "", error: (e as Error).message },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    )
  }
}
