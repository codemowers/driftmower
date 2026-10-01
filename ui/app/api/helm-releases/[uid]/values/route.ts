import { getReleaseValues } from "@/lib/features/helm-releases/releases"
import { isInCluster } from "@/lib/server/k8s"
import { guardRead } from "@/lib/server/sandbox-scope-filter"
import { errorResponse } from "@/lib/server/error-response"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const namespace = url.searchParams.get("namespace")
  const name = url.searchParams.get("name")

  if (!namespace || !name) {
    return Response.json({ error: "namespace and name query params are required" }, { status: 400 })
  }
  const denied = await guardRead(namespace)
  if (denied) return denied
  if (!isInCluster()) {
    return Response.json({ error: "Kubernetes API not reachable outside the cluster" }, { status: 503 })
  }

  try {
    const values = await getReleaseValues(namespace, name)
    if (!values) {
      return Response.json({ error: `No Helm release storage found for ${namespace}/${name}` }, { status: 404 })
    }
    return Response.json(values)
  } catch (e) {
    return errorResponse(e, "helm-releases", `values ${namespace}/${name}`)
  }
}
