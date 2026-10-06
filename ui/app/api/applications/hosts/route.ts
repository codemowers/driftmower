import { isInCluster } from "@/lib/server/k8s"
import { fetchSandboxScope } from "@/lib/server/platform-manager-proxy"
import { getHostEntries } from "@/lib/features/applications/hosts"
import { fetchRegisteredApps } from "@/lib/features/applications/registered"
import { hostOf } from "@/lib/features/applications/host-url"
import { errorResponse } from "@/lib/server/error-response"

export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store" }

// Two grants: hosts backing the caller's own registered apps, plus, when platform-manager
// answers, every host in the namespaces they may read.
export async function GET() {
  const [registered, scope] = await Promise.all([fetchRegisteredApps(), fetchSandboxScope()])
  const tenancy = scope.state === "ok" ? "ok" : scope.state
  const domainSuffix = process.env.DOMAIN_SUFFIX?.trim().replace(/^\.+|\.+$/g, "") || null

  if (!isInCluster()) {
    return Response.json({ hosts: [], tenancy, domainSuffix }, { headers: NO_STORE })
  }

  let entries
  try {
    entries = await getHostEntries()
  } catch (e) {
    return errorResponse(e, "applications", "hosts", { headers: NO_STORE })
  }

  const ownHosts = new Set(
    registered.state === "ok"
      ? registered.apps.map(app => hostOf(app.url)).filter((host): host is string => host !== null)
      : [],
  )
  const permitted = scope.state === "ok" ? new Set(scope.namespaces) : null
  const readsEveryNamespace = scope.state === "ok" && scope.admin

  const hosts = entries.filter(
    entry =>
      ownHosts.has(entry.host) || readsEveryNamespace || (permitted?.has(entry.namespace) ?? false),
  )

  return Response.json({ hosts, tenancy, domainSuffix }, { headers: NO_STORE })
}
