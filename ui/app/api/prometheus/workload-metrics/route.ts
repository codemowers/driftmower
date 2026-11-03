import { loadWorkloadMetrics } from "@/lib/features/prometheus/workload-metrics"
import { isKubeName, prometheus } from "@/lib/features/prometheus/proxy"
import { guardRead } from "@/lib/server/sandbox-scope-filter"

export const dynamic = "force-dynamic"

const MAX_PODS = 500

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams
  const namespace = sp.get("namespace") ?? ""
  const pods = (sp.get("pods") ?? "").split(",").filter(Boolean)
  if (!isKubeName(namespace) || pods.length > MAX_PODS || !pods.every(isKubeName)) {
    return Response.json({ error: `namespace and up to ${MAX_PODS} pods must be Kubernetes names` }, { status: 400 })
  }

  const denied = await guardRead(namespace)
  if (denied) return denied

  return Response.json(await loadWorkloadMetrics(prometheus, namespace, pods), { headers: { "Cache-Control": "no-store" } })
}
