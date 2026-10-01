import { isInCluster } from "@/lib/server/k8s"
import { listLivePatchUpgrades } from "@/lib/features/live-patch-upgrade/server/list"
import { errorResponse } from "@/lib/server/error-response"

export const dynamic = "force-dynamic"

export async function GET() {
  if (!isInCluster()) {
    return Response.json({ error: "Kubernetes API not reachable outside the cluster" }, { status: 503 })
  }

  try {
    return Response.json(await listLivePatchUpgrades(), { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return errorResponse(e, "live-patch-upgrade", "list")
  }
}
