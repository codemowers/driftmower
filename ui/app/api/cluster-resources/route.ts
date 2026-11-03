import { getClusterResources } from "@/lib/cluster-resources/resources"
import { readScope } from "@/lib/server/sandbox-scope-filter"
import { errorResponse } from "@/lib/server/error-response"

export const dynamic = "force-dynamic"

export async function GET() {
  const allows = await readScope()
  if (allows instanceof Response) return allows

  try {
    const resources = await getClusterResources()
    return Response.json(allows ? resources.filter(r => allows(r.namespace)) : resources, {
      headers: { "Cache-Control": "no-store" },
    })
  } catch (e) {
    return errorResponse(e, "cluster-resources")
  }
}
