import { getReleaseValues } from "@/lib/api/helm-releases"
import { isInCluster, KubeApiError } from "@/lib/api/k8s"
import { hasSession } from "@/lib/auth/session"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const namespace = url.searchParams.get("namespace")
  const name = url.searchParams.get("name")

  if (!namespace || !name) {
    return Response.json({ error: "namespace and name query params are required" }, { status: 400 })
  }
  if (!(await hasSession())) {
    return Response.json({ error: "not authenticated" }, { status: 401 })
  }
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
    if (e instanceof KubeApiError && e.status === 403) {
      return Response.json(
        { error: "The driftmower-ui service account cannot read Helm release secrets" },
        { status: 403 },
      )
    }
    return Response.json({ error: String((e as Error).message) }, { status: 502 })
  }
}
