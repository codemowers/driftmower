import { loadPodMetrics } from "@/lib/features/prometheus/pod-metrics"
import { isKubeName, prometheus } from "@/lib/features/prometheus/proxy"
import { guardRead } from "@/lib/server/sandbox-scope-filter"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams
  const namespace = sp.get("namespace") ?? ""
  const pod = sp.get("pod") ?? ""
  if (!isKubeName(namespace) || !isKubeName(pod)) {
    return Response.json({ error: "namespace and pod must be Kubernetes names" }, { status: 400 })
  }

  const denied = await guardRead(namespace)
  if (denied) return denied

  return Response.json(await loadPodMetrics(prometheus, namespace, pod), { headers: { "Cache-Control": "no-store" } })
}
