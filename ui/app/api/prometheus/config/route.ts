import { isInCluster, kubeApiGet } from "@/lib/server/k8s"
import { createTtlCache } from "@/lib/utils/ttl-cache"
import { errorResponse } from "@/lib/server/error-response"

export const dynamic = "force-dynamic"

type Ingress = {
  spec?: {
    tls?: { hosts?: string[] }[]
    rules?: { host?: string }[]
  }
}

const CACHE_TTL_MS = 30_000

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

const getPrometheusUrl = createTtlCache(CACHE_TTL_MS, discover)

export async function GET() {
  try {
    const url = await getPrometheusUrl()
    return Response.json({ url }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return errorResponse(e, "prometheus", "config", { headers: { "Cache-Control": "no-store" } })
  }
}
