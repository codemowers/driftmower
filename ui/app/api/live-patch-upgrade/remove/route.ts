import { removeLivePatchUpgrade } from "@/lib/features/live-patch-upgrade/server/apply"
import { parseLivePatchUpgradeRequest, livePatchUpgradeErrorResponse } from "@/lib/features/live-patch-upgrade/server/route-helpers"

export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  const parsed = await parseLivePatchUpgradeRequest(req)
  if (parsed instanceof Response) return parsed

  try {
    return Response.json(await removeLivePatchUpgrade(parsed.request, parsed.actor), { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return livePatchUpgradeErrorResponse(e)
  }
}
