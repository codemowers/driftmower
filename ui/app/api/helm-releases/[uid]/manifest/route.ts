import { getReleaseManifest, getReleaseManifestDocument, getReleaseManifestText } from "@/lib/features/helm-releases/releases"
import { isInCluster } from "@/lib/server/k8s"
import { hasSession } from "@/lib/auth/session"
import { errorResponse } from "@/lib/server/error-response"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const namespace = url.searchParams.get("namespace")
  const name = url.searchParams.get("name")
  const doc = url.searchParams.get("doc")

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
    if (doc === null) {
      const manifest = await getReleaseManifest(namespace, name)
      if (!manifest) {
        return Response.json({ error: `No Helm release storage found for ${namespace}/${name}` }, { status: 404 })
      }
      return Response.json(manifest)
    }

    if (doc === "all") {
      const text = await getReleaseManifestText(namespace, name)
      if (text === null) {
        return Response.json({ error: `No Helm release storage found for ${namespace}/${name}` }, { status: 404 })
      }
      return Response.json({ text })
    }

    const index = Number(doc)
    if (!Number.isInteger(index) || index < 0) {
      return Response.json({ error: "doc must be a non-negative integer" }, { status: 400 })
    }

    const document = await getReleaseManifestDocument(namespace, name, index)
    if (!document) {
      return Response.json({ error: `No manifest document ${index} for ${namespace}/${name}` }, { status: 404 })
    }
    return Response.json(document)
  } catch (e) {
    return errorResponse(e, "helm-releases", `manifest ${namespace}/${name}`)
  }
}
