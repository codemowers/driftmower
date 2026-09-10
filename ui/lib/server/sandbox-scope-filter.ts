import "server-only"

import { fetchSandboxScope, type SandboxScope } from "./platform-manager-proxy"

// null means every namespace is readable: without a usable tenancy control plane, nothing narrows.
export function namespaceFilter(scope: SandboxScope): ((namespace: string) => boolean) | null {
  if (scope.state !== "ok" || scope.admin) return null
  const permitted = new Set(scope.namespaces)
  return namespace => permitted.has(namespace)
}

export async function guardNamespace(namespace: string): Promise<Response | null> {
  const allows = namespaceFilter(await fetchSandboxScope())

  if (allows && !allows(namespace)) {
    return Response.json({ error: `namespace ${namespace} is out of scope` }, { status: 403 })
  }
  return null
}
