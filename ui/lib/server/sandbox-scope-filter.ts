import "server-only"

import { fetchSandboxScope } from "./platform-manager-proxy"
import { readVerdict, seesClusterWideViews, writeVerdict, type Denial } from "./scope-rules"

export type NamespaceFilter = ((namespace: string) => boolean) | null

function deny(denial: Denial): Response {
  return Response.json({ error: denial.reason }, { status: denial.status })
}

export async function readScope(): Promise<NamespaceFilter | Response> {
  const verdict = readVerdict(await fetchSandboxScope())
  if (!verdict.allow) return deny(verdict)
  const { namespaces } = verdict
  return namespaces && (namespace => namespaces.has(namespace))
}

export async function guardRead(namespace: string): Promise<Response | null> {
  const allows = await readScope()
  if (allows instanceof Response) return allows
  if (allows && !allows(namespace)) {
    return Response.json({ error: `namespace ${namespace} is out of scope` }, { status: 403 })
  }
  return null
}

export async function guardNamespace(namespace: string): Promise<Response | null> {
  const verdict = writeVerdict(await fetchSandboxScope(), namespace)
  return verdict.allow ? null : deny(verdict)
}

export async function guardClusterWide(): Promise<Response | null> {
  const verdict = readVerdict(await fetchSandboxScope())
  if (!verdict.allow) return deny(verdict)
  if (verdict.namespaces) {
    return Response.json({ error: "cluster-wide data is not available to sandbox users" }, { status: 403 })
  }
  return null
}

export async function callerSeesClusterWideViews(): Promise<boolean> {
  return seesClusterWideViews(await fetchSandboxScope())
}
