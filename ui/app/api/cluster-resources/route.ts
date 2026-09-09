import { getClusterResources } from "@/lib/cluster-resources/resources"
import { fetchTenantScope } from "@/lib/server/platform-manager-proxy"
import { namespaceFilter } from "@/lib/server/tenant-scope-filter"

export const dynamic = "force-dynamic"

export async function GET() {
  const [resources, scope] = await Promise.all([getClusterResources(), fetchTenantScope()])
  const allows = namespaceFilter(scope)

  return Response.json(allows ? resources.filter(r => allows(r.namespace)) : resources, {
    headers: { "Cache-Control": "no-store" },
  })
}
