import { isInCluster } from "@/lib/server/k8s"
import { fetchSandboxScope } from "@/lib/server/platform-manager-proxy"
import { getHostEntries } from "@/lib/features/applications/hosts"
import { fetchRegisteredApps } from "@/lib/features/applications/registered"
import { hostOf } from "@/lib/features/applications/host-url"

export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store" }

// Two grants: hosts backing the caller's own registered apps, plus, when platform-manager
// answers, every host in the namespaces they may read.
export async function GET() {
  const [registered, scope] = await Promise.all([fetchRegisteredApps(), fetchSandboxScope()])
  const tenancy = scope.state === "ok" ? "ok" : scope.state

  if (!isInCluster()) {
    return Response.json({ hosts: [], tenancy }, { headers: NO_STORE })
  }

  let entries
  try {
    entries = await getHostEntries()
  } catch (e) {
    return Response.json(
      { reason: "error", error: (e as Error).message },
      { status: 500, headers: NO_STORE },
    )
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

  return Response.json({ hosts, tenancy }, { headers: NO_STORE })
}
