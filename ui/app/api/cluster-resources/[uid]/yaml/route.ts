import { isInCluster } from "@/lib/server/k8s"
import { guardNamespace } from "@/lib/server/sandbox-scope-filter"
import { getResourceObject } from "@/lib/cluster-resources/resource-object"
import { supportsYamlView } from "@/lib/features/yaml/supported-kinds"

export const dynamic = "force-dynamic"

export async function GET(req: Request, { params }: { params: Promise<{ uid: string }> }) {
  const { uid } = await params
  const url = new URL(req.url)
  const kind = url.searchParams.get("kind")
  const namespace = url.searchParams.get("namespace")
  const name = url.searchParams.get("name")

  if (!kind || !namespace || !name) {
    return Response.json({ error: "kind, namespace and name query params are required" }, { status: 400 })
  }
  if (!supportsYamlView(kind)) {
    return Response.json({ error: `YAML view is not available for kind ${kind}` }, { status: 400 })
  }

  const denied = await guardNamespace(namespace)
  if (denied) return denied

  if (!isInCluster()) {
    return Response.json({ error: "Kubernetes API not reachable outside the cluster" }, { status: 503 })
  }

  let resource
  try {
    resource = await getResourceObject(kind, namespace, name)
  } catch (e) {
    return Response.json({ error: String((e as Error).message) }, { status: 502 })
  }

  if (!resource || resource.metadata?.uid !== uid) {
    return Response.json({ error: "Resource not found or its uid changed" }, { status: 404 })
  }

  return Response.json(resource)
}
