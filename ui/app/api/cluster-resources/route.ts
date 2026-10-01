import { getClusterResources } from "@/lib/cluster-resources/resources"
import { fetchSandboxScope } from "@/lib/server/platform-manager-proxy"
import { namespaceFilter } from "@/lib/server/sandbox-scope-filter"
import { errorResponse } from "@/lib/server/error-response"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const [resources, scope] = await Promise.all([getClusterResources(), fetchSandboxScope()])
    const allows = namespaceFilter(scope)
    return Response.json(allows ? resources.filter(r => allows(r.namespace)) : resources, {
      headers: { "Cache-Control": "no-store" },
    })
  } catch (e) {
    return errorResponse(e, "cluster-resources")
  }
}
