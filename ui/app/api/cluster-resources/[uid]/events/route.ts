import { isInCluster } from "@/lib/server/k8s"
import { guardNamespace } from "@/lib/server/sandbox-scope-filter"
import { getPodEvents } from "@/lib/cluster-resources/events"

export const dynamic = "force-dynamic"

export async function GET(req: Request, { params }: { params: Promise<{ uid: string }> }) {
  const { uid } = await params
  const namespace = new URL(req.url).searchParams.get("namespace")

  if (!namespace) {
    return Response.json({ error: "namespace query param is required" }, { status: 400 })
  }

  const denied = await guardNamespace(namespace)
  if (denied) return denied

  if (!isInCluster()) {
    return Response.json({ error: "Kubernetes API not reachable outside the cluster" }, { status: 503 })
  }

  try {
    const events = await getPodEvents(namespace, uid)
    return Response.json({ events }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return Response.json({ error: String((e as Error).message) }, { status: 502 })
  }
}
