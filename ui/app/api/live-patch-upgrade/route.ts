import { isInCluster } from "@/lib/server/k8s"
import { listLivePatchUpgrades } from "@/lib/features/live-patch-upgrade/server/list"
import { livePatchUpgradeErrorResponse } from "@/lib/features/live-patch-upgrade/server/route-helpers"

export const dynamic = "force-dynamic"

export async function GET() {
  if (!isInCluster()) {
    return Response.json({ error: "Kubernetes API not reachable outside the cluster" }, { status: 503 })
  }

  try {
    return Response.json(await listLivePatchUpgrades(), { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return livePatchUpgradeErrorResponse(e, "list")
  }
}
