import { isInCluster, kubeApiGet } from "@/lib/api/k8s"
import { createTtlCache } from "@/lib/api/ttl-cache"

export const dynamic = "force-dynamic"

type IngressList = {
  items: {
    metadata?: { name?: string; namespace?: string; labels?: Record<string, string> }
    spec?: {
      tls?: { hosts?: string[] }[]
      rules?: { host?: string }[]
    }
  }[]
}

const LABEL_SELECTOR = "app=netstatd"
const CACHE_TTL_MS = 30_000

function pickHost(items: IngressList["items"]): { host: string; tls: boolean } | null {
  for (const item of items) {
    const tlsHosts = item.spec?.tls?.flatMap(t => t.hosts ?? []) ?? []
    if (tlsHosts.length > 0 && tlsHosts[0]) return { host: tlsHosts[0], tls: true }
  }
  for (const item of items) {
    const ruleHost = item.spec?.rules?.[0]?.host
    if (ruleHost) return { host: ruleHost, tls: false }
  }
  return null
}

async function discover(): Promise<string> {
  const override = process.env.NETSTATD_URL
  if (override) return override

  if (!isInCluster()) {
    console.warn("[kube-api] netstatd discovery: Kubernetes API not reachable (KUBERNETES_SERVICE_HOST unset, e.g. localhost) — returning empty")
    return ""
  }

  const list = await kubeApiGet<IngressList>(
    `/apis/networking.k8s.io/v1/ingresses?labelSelector=${encodeURIComponent(LABEL_SELECTOR)}`,
  )
  const picked = pickHost(list.items)
  if (!picked) return ""
  return `${picked.tls ? "https" : "http"}://${picked.host}`
}

const getNetstatdUrl = createTtlCache(CACHE_TTL_MS, discover)

export async function GET() {
  try {
    const url = await getNetstatdUrl()
    return Response.json({ url }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return Response.json(
      { url: "", error: (e as Error).message },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    )
  }
}
