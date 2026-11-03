import { getClusterNodes } from "@/lib/cluster-resources/nodes"
import { guardClusterWide } from "@/lib/server/sandbox-scope-filter"

export const dynamic = "force-dynamic"

export async function GET() {
  const denied = await guardClusterWide()
  if (denied) return denied

  return Response.json(await getClusterNodes())
}
